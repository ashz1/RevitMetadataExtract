const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const app = express();
app.use(express.json({ limit: '500mb' }));
app.use(express.urlencoded({ limit: '500mb', extended: true }));

// Autodesk credentials
const CLIENT_ID = process.env.APS_CLIENT_ID;
const CLIENT_SECRET = process.env.APS_CLIENT_SECRET;
const BUCKET = process.env.APS_BUCKET;

async function getAccessToken() {
  const res = await axios.post(
    'https://developer.api.autodesk.com/authentication/v1/authenticate',
    `client_id=${CLIENT_ID}&client_secret=${CLIENT_SECRET}&grant_type=client_credentials&scope=data:read data:write bucket:read bucket:create`,
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );
  return res.data.access_token;
}

async function getMetadata(urn, guid, token) {
  const url = `https://developer.api.autodesk.com/modelderivative/v2/designdata/${urn}/metadata/${guid}/properties`;
  const res = await axios.get(url, { headers: { Authorization: `Bearer ${token}` } });
  return res.data.data.collection;
}

function filterProperties(elements) {
  return elements.map(el => {
    const props = el.properties || {};
    return {
      name: el.name || '',
      length: props['Dimensions']?.Length || '',
      width: props['Dimensions']?.Width || '',
      height: props['Dimensions']?.Height || '',
      material: props['Materials']?.Material || ''
    };
  });
}

app.get('/extract/:urn/:guid', async (req, res) => {
  try {
    const token = await getAccessToken();
    const allProps = await getMetadata(req.params.urn, req.params.guid, token);
    const filtered = filterProperties(allProps);

    const filePath = path.join(__dirname, 'metadata.json');
    fs.writeFileSync(filePath, JSON.stringify(filtered, null, 2));
    res.download(filePath, 'metadata.json');
  } catch (err) {
    console.error(err);
    res.status(500).send('Error extracting metadata');
  }
});

app.listen(process.env.PORT || 3000, () => {
  console.log(`Server running on port ${process.env.PORT || 3000}`);
});
