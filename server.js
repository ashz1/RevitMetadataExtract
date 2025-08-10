import express from 'express';
import dotenv from 'dotenv';
import fs from 'fs-extra';
import axios from 'axios';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const { APS_CLIENT_ID, APS_CLIENT_SECRET, APS_BUCKET } = process.env;

const TEMP_RVT_FILE = path.join(__dirname, 'temp_download.rvt');
const OUTPUT_JSON = path.join(__dirname, 'metadata.json');

// (Reuse all helper functions from before here: getAccessToken, createBucket, getSignedUploadUrls, uploadToS3, finalizeUpload, translateFile, waitForTranslation, getMetadata)

async function getAccessToken() {
  // same as before
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

async function createBucket(token) {
  try {
    await axios.post(
      'https://developer.api.autodesk.com/oss/v2/buckets',
      { bucketKey: APS_BUCKET, policyKey: 'transient' },
      { headers: { Authorization: `Bearer ${token}` } }
    );
  } catch (e) {
    if (e.response?.status !== 409) throw e;
  }
}

async function getSignedUploadUrls(token, fileName) {
  const url = `https://developer.api.autodesk.com/oss/v2/buckets/${APS_BUCKET}/objects/${fileName}/signeds3upload?minutesExpiration=60`;
  const resp = await axios.get(url, {
    headers: { Authorization: `Bearer ${token}` }
  });
  return resp.data;
}

async function uploadToS3(signedUrls, filePath) {
  const fileData = await fs.readFile(filePath);
  await axios.put(signedUrls[0], fileData, {
    headers: { 'Content-Type': 'application/octet-stream' }
  });
}

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

async function waitForTranslation(token, urn, timeoutMs = 120000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const resp = await axios.get(
      `https://developer.api.autodesk.com/modelderivative/v2/designdata/${urn}/manifest`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (resp.data.status === 'success') return;
    if (resp.data.status === 'failed') throw new Error('Translation failed');
    await new Promise(r => setTimeout(r, 5000));
  }
  throw new Error('Translation timed out');
}

async function getMetadata(token, urn) {
  const resp = await axios.get(
    `https://developer.api.autodesk.com/modelderivative/v2/designdata/${urn}/metadata`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  return resp.data;
}

// Download RVT from user URL and save locally
async function downloadRVT(url, outputPath) {
  const writer = fs.createWriteStream(outputPath);
  const response = await axios({
    url,
    method: 'GET',
    responseType: 'stream',
  });
  response.data.pipe(writer);
  return new Promise((resolve, reject) => {
    writer.on('finish', resolve);
    writer.on('error', reject);
  });
}

// Routes

app.get('/', (req, res) => {
  res.send(`
    <h1>Upload RVT File by URL</h1>
    <form method="POST" action="/extract">
      <input type="url" name="fileUrl" placeholder="Enter RVT file URL" required style="width:400px;">
      <button type="submit">Extract Metadata</button>
    </form>
  `);
});

app.post('/extract', async (req, res) => {
  const fileUrl = req.body.fileUrl;
  if (!fileUrl) return res.status(400).send('Missing fileUrl parameter');

  try {
    console.log(`Downloading RVT file from: ${fileUrl}`);
    await downloadRVT(fileUrl, TEMP_RVT_FILE);

    const fileName = path.basename(TEMP_RVT_FILE);
    const token = await getAccessToken();
    await createBucket(token);

    const signedUpload = await getSignedUploadUrls(token, fileName);
    await uploadToS3(signedUpload.urls, TEMP_RVT_FILE);

    const objectId = await finalizeUpload(token, fileName, signedUpload.uploadKey);
    const urn = await translateFile(token, objectId);

    await waitForTranslation(token, urn);

    const metadata = await getMetadata(token, urn);

    await fs.writeJson(OUTPUT_JSON, metadata, { spaces: 2 });

    // Clean up temp file after extraction
    await fs.remove(TEMP_RVT_FILE);

    res.send(`
      <h2>Metadata extraction completed!</h2>
      <p><a href="/download/json">Download metadata JSON</a></p>
      <p><a href="/">Back</a></p>
    `);
  } catch (err) {
    console.error(err);
    // Clean up temp file on error
    await fs.remove(TEMP_RVT_FILE).catch(() => {});
    res.status(500).send(`<h3>Error:</h3><pre>${err.message}</pre><p><a href="/">Back</a></p>`);
  }
});

app.get('/download/json', (req, res) => {
  res.download(OUTPUT_JSON, 'metadata.json', err => {
    if (err) res.status(404).send('JSON file not found');
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));
