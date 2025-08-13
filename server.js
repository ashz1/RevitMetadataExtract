import express from 'express';
import axios from 'axios';
import path from 'path';
import fs from 'fs-extra';
import 'dotenv/config';

const app = express();
const __dirname = path.resolve();

// Config
const OUTPUT_JSON_DIR = path.join(__dirname, 'output');
await fs.ensureDir(OUTPUT_JSON_DIR);

const RVT_FILES = [
  'Snowdon Towers Sample HVAC.rvt',
  'racadvancedsampleproject.rvt',
  'racbasicsampleproject.rvt',
  'rstadvancedsampleproject.rvt'
];

// Middleware
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// APS Auth
async function getAccessToken() {
  const resp = await axios.post('https://developer.api.autodesk.com/authentication/v1/authenticate', new URLSearchParams({
    client_id: process.env.APS_CLIENT_ID,
    client_secret: process.env.APS_CLIENT_SECRET,
    grant_type: 'client_credentials',
    scope: 'data:read data:write data:create bucket:create bucket:read'
  }));
  return resp.data.access_token;
}

// Create bucket
async function createBucket(token) {
  try {
    await axios.post('https://developer.api.autodesk.com/oss/v2/buckets', {
      bucketKey: process.env.APS_BUCKET,
      policyKey: 'transient'
    }, {
      headers: { Authorization: `Bearer ${token}` }
    });
  } catch (err) {
    if (err.response && err.response.status !== 409) throw err;
  }
}

// Get signed upload URLs
async function getSignedUploadUrls(token, filename) {
  const resp = await axios.post(`https://developer.api.autodesk.com/oss/v2/buckets/${process.env.APS_BUCKET}/objects/${encodeURIComponent(filename)}/signeds3upload`, {}, {
    headers: { Authorization: `Bearer ${token}` }
  });
  return resp.data;
}

// Upload file to S3
async function uploadToS3(urls, filePath) {
  const fileData = await fs.readFile(filePath);
  for (const url of urls) {
    await axios.put(url, fileData, { headers: { 'Content-Type': 'application/octet-stream' } });
  }
}

// Finalize upload
async function finalizeUpload(token, filename, uploadKey) {
  const resp = await axios.post(`https://developer.api.autodesk.com/oss/v2/buckets/${process.env.APS_BUCKET}/objects/${encodeURIComponent(filename)}/signeds3upload`, {
    uploadKey
  }, {
    headers: { Authorization: `Bearer ${token}` }
  });
  return resp.data.objectId;
}

// Translate file to SVF2
async function translateFile(token, objectId) {
  const urn = Buffer.from(objectId).toString('base64').replace(/=/g, '');
  await axios.post('https://developer.api.autodesk.com/modelderivative/v2/designdata/job', {
    input: { urn },
    output: { formats: [{ type: 'svf2', views: ['2d', '3d'] }] }
  }, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  });
  return urn;
}

// Wait for translation
async function waitForTranslation(token, urn) {
  let done = false;
  while (!done) {
    const resp = await axios.get(`https://developer.api.autodesk.com/modelderivative/v2/designdata/${urn}/manifest`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (resp.data.status === 'success') {
      done = true;
    } else if (resp.data.status === 'failed') {
      throw new Error('Translation failed');
    } else {
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

// Get metadata tree
async function getMetadata(token, urn) {
  const resp = await axios.get(`https://developer.api.autodesk.com/modelderivative/v2/designdata/${urn}/metadata`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  return resp.data;
}

// Get detailed properties for GUID
async function getModelProperties(token, urn, guid) {
  const url = `https://developer.api.autodesk.com/modelderivative/v2/designdata/${urn}/metadata/${guid}/properties`;
  const resp = await axios.get(url, {
    headers: { Authorization: `Bearer ${token}` }
  });
  return resp.data;
}

// Routes
app.get('/', (req, res) => {
  const fileOptions = RVT_FILES.map(f => `<option value="${f}">${f}</option>`).join('');
  res.send(`
    <html>
    <head>
      <title>RVT Metadata Extractor</title>
      <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css">
    </head>
    <body class="bg-light">
      <div class="container py-5">
        <h1 class="mb-4">RVT Metadata Extractor</h1>
        <form method="POST" action="/extract">
          <div class="mb-3">
            <label for="rvtfile" class="form-label">Select RVT File</label>
            <select name="rvtfile" class="form-select">${fileOptions}</select>
          </div>
          <button class="btn btn-primary">Extract Metadata</button>
        </form>
        <hr>
        <p><a href="/downloads">View all downloaded JSONs</a></p>
        <p><a href="https://github.com/ashz1/RevitMetadataExtract" target="_blank">View GitHub Repo</a></p>
      </div>
    </body>
    </html>
  `);
});

app.post('/extract', async (req, res) => {
  try {
    const selectedFile = req.body.rvtfile;

    if (!RVT_FILES.includes(selectedFile)) {
      return res.status(400).send('Invalid file selected');
    }

    const filePath = path.join(__dirname, selectedFile);
    if (!fs.existsSync(filePath)) {
      return res.status(404).send('Selected RVT file not found');
    }

    const token = await getAccessToken();
    await createBucket(token);

    const signedUpload = await getSignedUploadUrls(token, selectedFile);
    await uploadToS3(signedUpload.urls, filePath);

    const objectId = await finalizeUpload(token, selectedFile, signedUpload.uploadKey);
    const urn = await translateFile(token, objectId);
    await waitForTranslation(token, urn);

    const metadataTree = await getMetadata(token, urn);
    const firstGuid = metadataTree.data.metadata[0].guid;

    const properties = await getModelProperties(token, urn, firstGuid);

    const safeFileName = selectedFile.replace(/[^a-z0-9]/gi, '_').toLowerCase() + '_properties.json';
    const outputFilePath = path.join(OUTPUT_JSON_DIR, safeFileName);
    await fs.writeJson(outputFilePath, properties, { spaces: 2 });

    res.send(`
      <div style="max-width:600px; margin:auto; padding:20px; text-align:center;">
        <h2>Property extraction completed for <strong>${selectedFile}</strong>!</h2>
        <p><a href="/download/${encodeURIComponent(safeFileName)}" class="btn btn-success">Download properties JSON</a></p>
        <p><a href="/">Back to Home</a></p>
        <p><a href="/downloads">View all metadata files</a></p>
      </div>
    `);

  } catch (err) {
    console.error(err);
    res.status(500).send(`
      <div style="max-width:600px; margin:auto; padding:20px; color:red;">
        <h3>Error:</h3>
        <pre>${err.message}</pre>
        <p><a href="/">Back to Home</a></p>
      </div>
    `);
  }
});

app.get('/downloads', async (req, res) => {
  const files = await fs.readdir(OUTPUT_JSON_DIR);
  const links = files.map(f => `<li><a href="/download/${encodeURIComponent(f)}">${f}</a></li>`).join('');
  res.send(`<h2>Downloaded JSON Files</h2><ul>${links}</ul><p><a href="/">Back</a></p>`);
});

app.get('/download/:filename', (req, res) => {
  const filePath = path.join(OUTPUT_JSON_DIR, req.params.filename);
  res.download(filePath);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server listening at http://localhost:${PORT}`));
