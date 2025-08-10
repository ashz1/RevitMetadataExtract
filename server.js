import express from 'express';
import dotenv from 'dotenv';
import fs from 'fs';
import axios from 'axios';
import FormData from 'form-data';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();
const app = express();
app.use(express.json());

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const { APS_CLIENT_ID, APS_CLIENT_SECRET, APS_BUCKET } = process.env;

// Get access token
async function getAccessToken() {
  const resp = await axios.post(
    'https://developer.api.autodesk.com/authentication/v1/authenticate',
    new URLSearchParams({
      client_id: APS_CLIENT_ID,
      client_secret: APS_CLIENT_SECRET,
      grant_type: 'client_credentials',
      scope: 'data:read data:write bucket:create bucket:read'
    }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );
  return resp.data.access_token;
}

// Create bucket (if not exists)
async function createBucket(token) {
  try {
    await axios.post(
      'https://developer.api.autodesk.com/oss/v2/buckets',
      { bucketKey: APS_BUCKET, policyKey: 'transient' },
      { headers: { Authorization: `Bearer ${token}` } }
    );
  } catch (err) {
    if (err.response?.status !== 409) {
      throw err;
    }
  }
}

// Upload RVT file
async function uploadFile(token, filePath) {
  const fileName = path.basename(filePath);
  const fileSize = fs.statSync(filePath).size;
  const fileStream = fs.createReadStream(filePath);

  const resp = await axios.put(
    `https://developer.api.autodesk.com/oss/v2/buckets/${APS_BUCKET}/objects/${fileName}`,
    fileStream,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/octet-stream',
        'Content-Length': fileSize
      }
    }
  );
  return resp.data.objectId;
}

// Translate to SVF to get metadata
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

// Extract metadata
async function getMetadata(token, urn) {
  const resp = await axios.get(
    `https://developer.api.autodesk.com/modelderivative/v2/designdata/${urn}/metadata`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  return resp.data;
}

// Route: Extract metadata
app.post('/extract', async (req, res) => {
  try {
    const token = await getAccessToken();
    await createBucket(token);
    const objectId = await uploadFile(token, path.join(__dirname, 'racbasicsampleproject.rvt'));
    const urn = await translateFile(token, objectId);

    // Wait a few seconds before fetching metadata (simplest way)
    setTimeout(async () => {
      const metadata = await getMetadata(token, urn);
      res.json(metadata);
    }, 10000);
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).send(err.response?.data || err.message);
  }
});

app.use(express.static(path.join(__dirname, 'public')));
app.listen(process.env.PORT || 3000, () =>
  console.log(`Server running on http://localhost:${process.env.PORT || 3000}`)
);
