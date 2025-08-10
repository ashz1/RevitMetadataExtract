import express from 'express';
import dotenv from 'dotenv';
import fs from 'fs-extra';
import axios from 'axios';
import path from 'path';
import { fileURLToPath } from 'url';
import XLSX from 'xlsx';

dotenv.config();

const app = express();
app.use(express.json());

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const { APS_CLIENT_ID, APS_CLIENT_SECRET, APS_BUCKET } = process.env;

const RVT_FILE = path.join(__dirname, 'racbasicsampleproject.rvt');
const OUTPUT_JSON = path.join(__dirname, 'metadata.json');
const OUTPUT_XLSX = path.join(__dirname, 'metadata.xlsx');

// OAuth2 token
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

// Create bucket
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

// Upload to S3
async function uploadToS3(signedUrls, filePath) {
  const fileData = await fs.readFile(filePath);
  await axios.put(signedUrls[0], fileData, {
    headers: { 'Content-Type': 'application/octet-stream' }
  });
}

// Finalize upload and get objectId
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

// Save metadata JSON to Excel with safe checks
function saveMetadataToExcel(metadata, outputPath) {
  if (!metadata?.data?.metadata?.length) {
    throw new Error('No metadata objects found to save to Excel');
  }

  const firstMeta = metadata.data.metadata[0];

  if (!firstMeta.properties || !Array.isArray(firstMeta.properties)) {
    throw new Error('Metadata properties missing or invalid');
  }

  // Prepare rows from properties safely
  const rows = firstMeta.properties.map(p => ({
    Name: p.name || '',
    Category: p.category || '',
    Type: p.type || '',
    Value: p.displayValue ?? p.value ?? ''
  }));

  if (rows.length === 0) {
    throw new Error('No metadata properties found to save');
  }

  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Metadata');
  XLSX.writeFile(wb, outputPath);
  console.log(`Excel saved to ${outputPath}`);
}

// Root page with extract button
app.get('/', (req, res) => {
  res.send(`
    <h1>Extract Metadata from RVT</h1>
    <form method="POST" action="/extract">
      <button type="submit">Extract Metadata</button>
    </form>
    <p>After extraction, download <a href="/download/json">metadata JSON</a> or <a href="/download/excel">metadata Excel</a>.</p>
  `);
});

// Extract route
app.post('/extract', async (req, res) => {
  try {
    const fileName = path.basename(RVT_FILE);
    const token = await getAccessToken();
    await createBucket(token);

    const signedUpload = await getSignedUploadUrls(token, fileName);
    await uploadToS3(signedUpload.urls, RVT_FILE);

    const objectId = await finalizeUpload(token, fileName, signedUpload.uploadKey);
    const urn = await translateFile(token, objectId);

    await waitForTranslation(token, urn);

    const metadata = await getMetadata(token, urn);

    // Debug logs to check metadata structure
    console.log('Metadata keys:', Object.keys(metadata));
    console.log('Metadata.data keys:', metadata.data ? Object.keys(metadata.data) : 'undefined');
    console.log('First metadata object:', metadata.data?.metadata?.[0] || 'none');

    // Save JSON
    await fs.writeJson(OUTPUT_JSON, metadata, { spaces: 2 });

    // Save Excel
    saveMetadataToExcel(metadata, OUTPUT_XLSX);

    res.send(`
      <h2>Metadata extraction completed!</h2>
      <p><a href="/download/json">Download JSON</a></p>
      <p><a href="/download/excel">Download Excel</a></p>
      <p><a href="/">Back</a></p>
    `);
  } catch (err) {
    console.error(err);
    res.status(500).send(`<h3>Error:</h3><pre>${err.message}</pre><p><a href="/">Back</a></p>`);
  }
});

// Metadata JSON download route
app.get('/download/json', (req, res) => {
  res.download(OUTPUT_JSON, 'metadata.json', err => {
    if (err) res.status(404).send('JSON file not found');
  });
});

// Metadata Excel download route
app.get('/download/excel', (req, res) => {
  res.download(OUTPUT_XLSX, 'metadata.xlsx', err => {
    if (err) res.status(404).send('Excel file not found');
  });
});

// Helper: Get metadata function
async function getMetadata(token, urn) {
  const resp = await axios.get(
    `https://developer.api.autodesk.com/modelderivative/v2/designdata/${urn}/metadata`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  return resp.data;
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
