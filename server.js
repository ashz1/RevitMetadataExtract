// server.js
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const multer = require('multer');
const XLSX = require('xlsx');

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

const PORT = process.env.PORT || 3000;
const APS_HOST = process.env.APS_HOST || 'https://developer.api.autodesk.com';
const CLIENT_ID = process.env.APS_CLIENT_ID;
const CLIENT_SECRET = process.env.APS_CLIENT_SECRET;
const BUCKET_KEY = process.env.APS_BUCKET || (`appbucket_${CLIENT_ID.replace(/[^a-z0-9]/gi,'').toLowerCase()}`);

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Set APS_CLIENT_ID and APS_CLIENT_SECRET in .env');
  process.exit(1);
}

/** Get a 2-legged access token (OAuth v2) */
async function get2LeggedToken(scopes = 'data:read data:write bucket:create bucket:read') {
  const basic = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
  const params = new URLSearchParams();
  params.append('grant_type', 'client_credentials');
  params.append('scope', scopes);

  const url = `${APS_HOST}/authentication/v2/token`;
  const resp = await axios.post(url, params.toString(), {
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    }
  });
  return resp.data.access_token;
}

/** Create a bucket (if not exists) */
async function createBucketIfNotExists(token, bucketKey) {
  const url = `${APS_HOST}/oss/v2/buckets`;
  try {
    await axios.post(url, { bucketKey, policyKey: 'transient' }, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
    });
    console.log('Bucket created:', bucketKey);
  } catch (err) {
    if (err.response && err.response.status === 409) {
      // bucket already exists
      console.log('Bucket exists:', bucketKey);
    } else {
      throw err;
    }
  }
}

/** Upload an object to OSS */
async function uploadObject(token, bucketKey, objectName, buffer) {
  const url = `${APS_HOST}/oss/v2/buckets/${encodeURIComponent(bucketKey)}/objects/${encodeURIComponent(objectName)}`;
  const resp = await axios.put(url, buffer, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/octet-stream',
      'Content-Length': buffer.length
    }
  });
  return resp.data; // includes objectId
}

/** Request model translation (SVF) */
async function postTranslateJob(token, base64Urn) {
  const url = `${APS_HOST}/modelderivative/v2/designdata/job`;
  const body = {
    input: { urn: base64Urn },
    output: { formats: [{ type: 'svf', views: ['2d','3d'] }] }
  };
  const resp = await axios.post(url, body, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  });
  return resp.data;
}

/** Poll manifest until translation finishes (or fails) */
async function pollManifest(token, base64Urn, timeoutMs = 5 * 60 * 1000) {
  const start = Date.now();
  while (true) {
    const url = `${APS_HOST}/modelderivative/v2/designdata/${encodeURIComponent(base64Urn)}/manifest`;
    try {
      const resp = await axios.get(url, { headers: { Authorization: `Bearer ${token}` } });
      const status = resp.data.status && resp.data.status.toLowerCase();
      if (status === 'success') return resp.data;
      if (status === 'failed') throw new Error('Translation failed: ' + JSON.stringify(resp.data));
    } catch (err) {
      // if 404 or not ready, continue
      if (err.response && err.response.status === 404) {
        // not yet available
      } else {
        // other error: throw
        console.warn('Manifest check error (ignored):', err.message);
      }
    }
    if (Date.now() - start > timeoutMs) throw new Error('Timeout waiting for translation manifest');
    await new Promise(r => setTimeout(r, 2000));
  }
}

/** Get metadata GUIDs */
async function getMetadata(token, base64Urn) {
  const url = `${APS_HOST}/modelderivative/v2/designdata/${encodeURIComponent(base64Urn)}/metadata`;
  const resp = await axios.get(url, { headers: { Authorization: `Bearer ${token}` } });
  return resp.data.data ? resp.data.data.metadata || resp.data.metadata || resp.data : resp.data;
}

/** Get properties for a GUID */
async function getProperties(token, base64Urn, guid) {
  const url = `${APS_HOST}/modelderivative/v2/designdata/${encodeURIComponent(base64Urn)}/metadata/${encodeURIComponent(guid)}/properties`;
  const resp = await axios.get(url, { headers: { Authorization: `Bearer ${token}` } });
  return resp.data;
}

/** flatten properties JSON for xlsx rows */
function flattenObjectProperties(item) {
  // item example shape: { objectid, name, properties: { 'Identity Data': { 'Type Name': { displayValue: '...' } } } }
  // We'll flatten into a single-level row { objectid, name, prop1: val, prop2: val ... }
  const row = { objectid: item.objectid || item.objectId || '', name: item.name || '' };
  if (!item.properties) return row;

  // properties is a nested object by category -> property -> {displayValue}
  for (const category of Object.keys(item.properties)) {
    const props = item.properties[category];
    for (const propName of Object.keys(props)) {
      const valObj = props[propName];
      // try multiple fields
      let value = valObj.displayValue ?? valObj.displayCategory ?? valObj.type ?? '';
      // create column name including category to avoid collisions
      const col = `${category}::${propName}`;
      row[col] = value;
    }
  }
  return row;
}

/** Endpoint: serve static UI */
app.use(express.static('public'));

/** Main endpoint: upload file, translate, extract metadata, return XLSX */
app.post('/upload-and-extract', upload.single('rvtfile'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).send('No file uploaded (form field "rvtfile")');

    // 1) get token
    const token = await get2LeggedToken();

    // 2) ensure bucket exists
    await createBucketIfNotExists(token, BUCKET_KEY);

    // 3) upload file
    const filename = req.file.originalname;
    const uploadResp = await uploadObject(token, BUCKET_KEY, filename, req.file.buffer);
    const objectId = uploadResp.objectId || uploadResp.objectid || uploadResp.objectKey || uploadResp.objectKey;
    // objectId usually looks like: urn:adsk.objects:os.object:<bucketKey>/<objectName>
    if (!objectId) {
      return res.status(500).send('Upload response missing objectId: ' + JSON.stringify(uploadResp));
    }

    // 4) build base64 URN (Model Derivative expects base64 of objectId)
    const base64Urn = Buffer.from(objectId).toString('base64');

    // 5) request translation
    await postTranslateJob(token, base64Urn);

    // 6) poll until ready
    await pollManifest(token, base64Urn);

    // 7) get metadata list (multiple model views)
    const metaResp = await getMetadata(token, base64Urn);
    const metadataList = metaResp.metadata || metaResp.data?.metadata || metaResp; // be defensive

    // 8) for each metadata GUID get properties and flatten
    const workbook = XLSX.utils.book_new();

    // metadataList may be an array of { guid, name } objects
    for (const meta of metadataList) {
      const guid = meta.guid || meta.GUID || (meta.resource && meta.resource.guid);
      const name = meta.name || meta.displayName || guid || 'sheet';
      if (!guid) continue;

      const propsResp = await getProperties(token, base64Urn, guid);
      // propsResp.data.collection is the classic shape
      const collection = propsResp.data?.collection || propsResp.collection || propsResp;
      // ensure array
      const rows = (Array.isArray(collection) ? collection : []).map(flattenObjectProperties);
      const ws = XLSX.utils.json_to_sheet(rows);
      // Excel sheet name max 31 chars
      XLSX.utils.book_append_sheet(workbook, ws, name.substring(0, 31));
    }

    // 9) send as download
    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Disposition', `attachment; filename="rvt-metadata.xlsx"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buffer);

  } catch (err) {
    console.error('Error:', err.response?.data || err.message || err);
    res.status(500).send('Error: ' + (err.response?.data?.diagnostic || err.message || JSON.stringify(err)));
  }
});

app.listen(PORT, () => console.log(`Server running http://localhost:${PORT}`));
