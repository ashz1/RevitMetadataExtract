import express from 'express';
import dotenv from 'dotenv';
import fs from 'fs-extra';
import axios from 'axios';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const app = express();
app.use(express.urlencoded({ extended: true })); // to parse form data

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const { APS_CLIENT_ID, APS_CLIENT_SECRET, APS_BUCKET } = process.env;

const RVT_FILES = [
  'Snowdon Towers Sample HVAC.rvt',
  'racadvancedsampleproject.rvt',
  'racbasicsampleproject.rvt',
  'rstadvancedsampleproject.rvt'
];

const OUTPUT_JSON_DIR = path.join(__dirname, 'metadata_outputs');
await fs.ensureDir(OUTPUT_JSON_DIR);

// OAuth2 token function
async function getAccessToken() {
  const tokenUrl = 'https://developer.api.autodesk.com/authentication/v2/token';
  const params = new URLSearchParams({
    client_id: APS_CLIENT_ID,
    client_secret: APS_CLIENT_SECRET,
    grant_type: 'client_credentials',
    scope: 'data:read data:write bucket:create bucket:read'
  });
  const resp = await axios.post(tokenUrl, params.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
  });
  return resp.data.access_token;
}

// Create bucket if not exists
async function createBucket(token) {
  try {
    await axios.post(
      'https://developer.api.autodesk.com/oss/v2/buckets',
      { bucketKey: APS_BUCKET, policyKey: 'transient' },
      { headers: { Authorization: `Bearer ${token}` } }
    );
    console.log(`Bucket created: ${APS_BUCKET}`);
  } catch (e) {
    if (e.response?.status === 409) {
      console.log(`Bucket exists: ${APS_BUCKET}`);
    } else {
      throw e;
    }
  }
}

// Get signed upload URLs
async function getSignedUploadUrls(token, fileName) {
  const url = `https://developer.api.autodesk.com/oss/v2/buckets/${APS_BUCKET}/objects/${fileName}/signeds3upload?minutesExpiration=60`;
  const resp = await axios.get(url, {
    headers: { Authorization: `Bearer ${token}` }
  });
  return resp.data;
}

// Upload file to S3
async function uploadToS3(signedUrls, filePath) {
  const fileData = await fs.readFile(filePath);
  await axios.put(signedUrls[0], fileData, {
    headers: { 'Content-Type': 'application/octet-stream' }
  });
}

// Finalize upload
async function finalizeUpload(token, fileName, uploadKey) {
  const url = `https://developer.api.autodesk.com/oss/v2/buckets/${APS_BUCKET}/objects/${fileName}/signeds3upload`;
  const resp = await axios.post(url, { uploadKey }, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    }
  });
  return resp.data.objectId;
}

// Request translation
async function translateFile(token, objectId) {
  const base64Urn = Buffer.from(objectId).toString('base64').replace(/=/g, '');
  await axios.post(
    'https://developer.api.autodesk.com/modelderivative/v2/designdata/job',
    {
      input: { urn: base64Urn },
      output: { formats: [{ type: 'svf', views: ['3d', '2d'] }] }
    },
    { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
  );
  return base64Urn;
}

// Poll translation manifest until success or timeout
async function waitForTranslation(token, urn, timeoutMs = 120000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const resp = await axios.get(
      `https://developer.api.autodesk.com/modelderivative/v2/designdata/${urn}/manifest`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (resp.data.status === 'success') {
      return;
    }
    if (resp.data.status === 'failed') {
      throw new Error('Translation failed');
    }
    await new Promise(r => setTimeout(r, 5000));
  }
  throw new Error('Translation timed out');
}

// Get metadata
async function getMetadata(token, urn) {
  const resp = await axios.get(
    `https://developer.api.autodesk.com/modelderivative/v2/designdata/${urn}/metadata`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  return resp.data;
}

// Root route - show dropdown form
app.get('/', (req, res) => {
  const optionsHtml = RVT_FILES.map(
    file => `<option value="${file}">${file}</option>`
  ).join('\n');

  res.send(`
    <h1>Select RVT File to Extract Metadata</h1>
    <form method="POST" action="/extract">
      <label for="rvtfile">Choose file:</label>
      <select id="rvtfile" name="rvtfile" required>
        ${optionsHtml}
      </select>
      <button type="submit">Extract Metadata</button>
    </form>
    <p>After extraction, download <a href="/downloads">all metadata JSON files</a>.</p>
  `);
});

// List all JSON metadata files for download
app.get('/downloads', async (req, res) => {
  const files = await fs.readdir(OUTPUT_JSON_DIR);
  const links = files.map(f => `<li><a href="/download/${encodeURIComponent(f)}">${f}</a></li>`).join('\n');
  res.send(`
    <h1>Metadata JSON files</h1>
    <ul>${links}</ul>
    <p><a href="/">Back</a></p>
  `);
});

// Download route for individual metadata JSON files
app.get('/download/:filename', (req, res) => {
  const filePath = path.join(OUTPUT_JSON_DIR, req.params.filename);
  if (!fs.existsSync(filePath)) {
    return res.status(404).send('File not found');
  }
  res.download(filePath);
});

// Extract metadata for selected file
app.post('/extract', async (req, res) => {
  try {
    const selectedFile = req.body.rvtfile;

    if (!RVT_FILES.includes(selectedFile)) {
      return res.status(400).send('Invalid file selected');
    }

    const filePath = path.join(__dirname, selectedFile);
    if (!fs.existsSync(filePath)) {
      return res.status(404).send('Selected RVT file not found on server');
    }

    const token = await getAccessToken();
    await createBucket(token);

    const signedUpload = await getSignedUploadUrls(token, selectedFile);
    await uploadToS3(signedUpload.urls, filePath);

    const objectId = await finalizeUpload(token, selectedFile, signedUpload.uploadKey);
    const urn = await translateFile(token, objectId);

    await waitForTranslation(token, urn);

    const metadata = await getMetadata(token, urn);

    const safeFileName = selectedFile.replace(/[^a-z0-9]/gi, '_').toLowerCase() + '.json';
    const outputFilePath = path.join(OUTPUT_JSON_DIR, safeFileName);

    await fs.writeJson(outputFilePath, metadata, { spaces: 2 });

    res.send(`
      <h2>Metadata extraction completed for <strong>${selectedFile}</strong>!</h2>
      <p><a href="/download/${encodeURIComponent(safeFileName)}">Download metadata JSON</a></p>
      <p><a href="/">Back</a></p>
      <p><a href="/downloads">View all metadata files</a></p>
    `);

  } catch (err) {
    console.error(err);
    res.status(500).send(`<h3>Error:</h3><pre>${err.message}</pre><p><a href="/">Back</a></p>`);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
