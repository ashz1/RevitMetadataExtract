import express from 'express';
import dotenv from 'dotenv';
import fs from 'fs';
import axios from 'axios';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();
const app = express();
app.use(express.json());

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const { APS_CLIENT_ID, APS_CLIENT_SECRET, APS_BUCKET } = process.env;

// Get access token (OAuth v2, client_id/client_secret in body)
async function getAccessToken() {
  const tokenUrl = 'https://developer.api.autodesk.com/authentication/v2/token';

  const params = new URLSearchParams();
  params.append('client_id', APS_CLIENT_ID);
  params.append('client_secret', APS_CLIENT_SECRET);
  params.append('grant_type', 'client_credentials');
  params.append('scope', 'data:read data:write bucket:create bucket:read');

  const resp = await axios.post(tokenUrl, params.toString(), {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    }
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
  } catch (err) {
    if (err.response?.status !== 409) { // 409 = bucket exists
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

// Request translation to SVF (for metadata extraction)
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

// Get metadata JSON
async function getMetadata(token, urn) {
  const resp = await axios.get(
    `https://developer.api.autodesk.com/modelderivative/v2/designdata/${urn}/metadata`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  return resp.data;
}

// POST /extract route
app.post('/extract', async (req, res) => {
  try {
    const token = await getAccessToken();
    await createBucket(token);
    const objectId = await uploadFile(token, path.join(__dirname, 'racbasicsampleproject.rvt'));
    const urn = await translateFile(token, objectId);

    // Wait 10 seconds for translation to complete (simplified)
    setTimeout(async () => {
      const metadata = await getMetadata(token, urn);
      res.json(metadata);
    }, 10000);
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).send(err.response?.data || err.message);
  }
});

// Serve frontend from /public folder
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server listening at http://localhost:${PORT}`);
});
