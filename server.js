import express from 'express';
import axios from 'axios';
import fs from 'fs-extra';
import path from 'path';
import 'dotenv/config';
import fetch from 'node-fetch';
import marked from 'marked';

const __dirname = path.resolve();
const app = express();
app.use(express.urlencoded({ extended: true }));

// === CONFIG ===
const OUTPUT_JSON_DIR = path.join(__dirname, 'output_json');
await fs.ensureDir(OUTPUT_JSON_DIR);

const RVT_FILES = [
  'sample1.rvt',
  'sample2.rvt'
  // Add more file names here
];

// === HELPER: Read README.md as HTML ===
async function getReadmeHTML() {
  const readmePath = path.join(__dirname, 'README.md');
  if (!fs.existsSync(readmePath)) return '<p>No README found</p>';
  const md = await fs.readFile(readmePath, 'utf-8');
  return marked(md);
}

// === APS AUTH ===
async function getAccessToken() {
  const resp = await axios.post('https://developer.api.autodesk.com/authentication/v1/authenticate', null, {
    params: {
      client_id: process.env.APS_CLIENT_ID,
      client_secret: process.env.APS_CLIENT_SECRET,
      grant_type: 'client_credentials',
      scope: 'data:read data:write bucket:create bucket:read'
    }
  });
  return resp.data.access_token;
}

// === Create bucket ===
async function createBucket(token) {
  const bucketKey = process.env.APS_BUCKET;
  try {
    await axios.post(
      'https://developer.api.autodesk.com/oss/v2/buckets',
      { bucketKey, policyKey: 'transient' },
      { headers: { Authorization: `Bearer ${token}` } }
    );
  } catch (err) {
    if (err.response && err.response.status !== 409) throw err;
  }
}

// === Get signed upload URLs ===
async function getSignedUploadUrls(token, filename) {
  const bucketKey = process.env.APS_BUCKET;
  const resp = await axios.post(
    `https://developer.api.autodesk.com/oss/v2/buckets/${bucketKey}/objects/${encodeURIComponent(filename)}/signeds3upload`,
    { minutesExpiration: 60 },
    { headers: { Authorization: `Bearer ${token}` } }
  );
  return resp.data;
}

// === Upload to S3 signed URLs ===
async function uploadToS3(urls, filePath) {
  const fileData = await fs.readFile(filePath);
  for (const url of urls) {
    await axios.put(url, fileData, { headers: { 'Content-Type': 'application/octet-stream' } });
  }
}

// === Finalize upload ===
async function finalizeUpload(token, filename, uploadKey) {
  const bucketKey = process.env.APS_BUCKET;
  const resp = await axios.post(
    `https://developer.api.autodesk.com/oss/v2/buckets/${bucketKey}/objects/${encodeURIComponent(filename)}/signeds3upload`,
    { uploadKey },
    { headers: { Authorization: `Bearer ${token}` } }
  );
  return resp.data.objectId;
}

// === Translate file ===
async function translateFile(token, objectId) {
  const urn = Buffer.from(objectId).toString('base64').replace(/=/g, '');
  await axios.post(
    'https://developer.api.autodesk.com/modelderivative/v2/designdata/job',
    { input: { urn }, output: { formats: [{ type: 'svf', views: ['2d', '3d'] }] } },
    { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
  );
  return urn;
}

// === Wait for translation ===
async function waitForTranslation(token, urn) {
  for (let i = 0; i < 20; i++) {
    const resp = await axios.get(
      `https://developer.api.autodesk.com/modelderivative/v2/designdata/${urn}/manifest`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (resp.data.status === 'success') return;
    await new Promise(r => setTimeout(r, 10000));
  }
  throw new Error('Translation timed out.');
}

// === Get full element properties ===
async function getMetadata(token, urn) {
  const metaListResp = await axios.get(
    `https://developer.api.autodesk.com/modelderivative/v2/designdata/${urn}/metadata`,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  if (!metaListResp.data.data || !metaListResp.data.data.metadata || metaListResp.data.data.metadata.length === 0) {
    throw new Error('No metadata found for this model.');
  }

  const modelGuid = metaListResp.data.data.metadata[0].guid;

  const propsResp = await axios.get(
    `https://developer.api.autodesk.com/modelderivative/v2/designdata/${urn}/metadata/${modelGuid}/properties`,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  return propsResp.data;
}

// === Routes ===

// UI page
app.get('/', async (req, res) => {
  const readmeHTML = await getReadmeHTML();
  const optionsHtml = ['All', ...RVT_FILES].map(
    file => `<option value="${file}">${file}</option>`
  ).join('\n');

  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet" />
      <style>
        body { padding: 20px; background-color: #f8f9fa; }
        .container { max-width: 900px; }
        footer { margin-top: 40px; text-align: center; color: #6c757d; }
        pre { white-space: pre-wrap; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="border rounded p-3 bg-white" style="max-height: 400px; overflow-y: auto; width: 100%;">
          ${readmeHTML}
        </div>

        <section id="extract-form" class="mb-5">
          <h2>Select a RVT file</h2>
          <form method="POST" action="/extract" class="mb-3">
            <div class="mb-3">
              <select id="rvtfile" name="rvtfile" class="form-select" required>
                <option value="" disabled selected>Select a file...</option>
                ${optionsHtml}
              </select>
            </div>
            <button type="submit" class="btn btn-primary">Extract Metadata</button>
          </form>
        </section>

        <section id="downloads">
          <h2>Download Metadata Files</h2>
          <p><a href="/downloads" class="btn btn-outline-secondary">View All Metadata JSON Files</a></p>
        </section>

        <footer>
          &copy; 2025 Aashay Zende | aashayzende@gmail.com
        </footer>
      </div>
    </body>
    </html>
  `);
});

// Extraction route
app.post('/extract', async (req, res) => {
  try {
    const selectedFile = req.body.rvtfile;
    const filesToProcess = selectedFile === 'All' ? RVT_FILES : [selectedFile];
    const token = await getAccessToken();
    await createBucket(token);

    const results = [];

    for (const file of filesToProcess) {
      const filePath = path.join(__dirname, file);
      if (!fs.existsSync(filePath)) {
