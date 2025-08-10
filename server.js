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

// Step 1: Get OAuth v2 Access Token
async function getAccessToken() {
  const tokenUrl = 'https://developer.api.autodesk.com/authentication/v2/token';

  const params = new URLSearchParams();
  params.append('client_id', APS_CLIENT_ID);
  params.append('client_secret', APS_CLIENT_SECRET);
  params.append('grant_type', 'client_credentials');
  params.append('scope', 'data:read data:write bucket:create bucket:read');

  const resp = await axios.post(tokenUrl, params.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
  });

  return resp.data.access_token;
}

// Step 2: Create bucket if it does not exist
async function createBucket(token) {
  try {
    await axios.post(
      'https://developer.api.autodesk.com/oss/v2/buckets',
      { bucketKey: APS_BUCKET, policyKey: 'transient' },
      { headers: { Authorization: `Bearer ${token}` } }
    );
    console.log(`Bucket ${APS_BUCKET} created`);
  } catch (err) {
    if (err.response?.status === 409) {
      // Bucket already exists, ignore
      console.log(`Bucket ${APS_BUCKET} already exists`);
    } else {
      throw err;
    }
  }
}

// Step 3a: Get signed S3 upload URL(s)
async function getSignedUploadUrls(token, fileName) {
  const url = `https://developer.api.autodesk.com/oss/v2/buckets/${APS_BUCKET}/objects/${fileName}/signeds3upload?minutesExpiration=60`;
  const resp = await axios.get(url, {
    headers: { Authorization: `Bearer ${token}` }
  });
  return resp.data; // { uploadKey, urls: [<signed S3 URLs>] }
}

// Step 3b: Upload file to S3 signed URL(s)
async function uploadToS3(signedUrls, filePath) {
  const fileData = fs.readFileSync(filePath);
  // For simplicity, assume single URL (no multipart)
  const url = signedUrls[0];
  await axios.put(url, fileData, {
    headers: { 'Content-Type': 'application/octet-stream' }
  });
}

// Step 3c: Finalize upload
async function finalizeUpload(token, fileName, uploadKey) {
  const url = `https://developer.api.autodesk.com/oss/v2/buckets/${APS_BUCKET}/objects/${fileName}/signeds3upload`;
  const resp = await axios.post(url, { uploadKey }, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    }
  });
  return resp.data.objectId; // This is the "objectId" (URN) to use for translation
}

// Step 4: Request translation to SVF (to extract metadata)
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

// Step 5: Get metadata
async function getMetadata(token, urn) {
  const resp = await axios.get(
    `https://developer.api.autodesk.com/modelderivative/v2/designdata/${urn}/metadata`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  return resp.data;
}

// Endpoint to trigger metadata extraction
app.post('/extract', async (req, res) => {
  try {
    const filePath = path.join(__dirname, 'racbasicsampleproject.rvt');
    const fileName = path.basename(filePath);

    const token = await getAccessToken();
    await createBucket(token);

    // Get signed upload URLs
    const signedUpload = await getSignedUploadUrls(token, fileName);

    // Upload to S3
    await uploadToS3(signedUpload.urls, filePath);

    // Finalize upload & get objectId
    const objectId = await finalizeUpload(token, fileName, signedUpload.uploadKey);

    // Request translation
    const urn = await translateFile(token, objectId);

    // Wait for translation to complete - simple delay 10 sec (better to poll manifest in prod)
    setTimeout(async () => {
      const metadata = await getMetadata(token, urn);
      res.json(metadata);
    }, 10000);

  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).send(err.response?.data || err.message);
  }
});
app.get('/', (req, res) => {
  res.send(`
    <h1>APS RVT Metadata Extractor</h1>
    <form method="POST" action="/extract">
      <button type="submit">Extract Metadata</button>
    </form>
  `);
});

app.listen(process.env.PORT || 3000, () => {
  console.log(`Server running on http://localhost:${process.env.PORT || 3000}`);
});
