import express from 'express';
import dotenv from 'dotenv';
import fs from 'fs-extra';
import axios from 'axios';
import path from 'path';
import { fileURLToPath } from 'url';
import { marked } from 'marked';

dotenv.config();

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json()); // to parse JSON bodies

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const { APS_CLIENT_ID, APS_CLIENT_SECRET, APS_BUCKET } = process.env;

const RVT_FILES = [
  'all',
  'Snowdon Towers Sample HVAC.rvt',
  'racadvancedsampleproject.rvt',
];

const OUTPUT_JSON_DIR = path.join(__dirname, 'metadata_outputs');
await fs.ensureDir(OUTPUT_JSON_DIR);

// Read README.md and convert to HTML
async function getReadmeHTML() {
  try {
    const md = await fs.readFile(path.join(__dirname, 'README.md'), 'utf-8');
    return marked(md);
  } catch {
    return '<p><em>README.md file not found</em></p>';
  }
}

// Autodesk Forge OAuth2 token
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

// Get signed upload URLs for S3 upload
async function getSignedUploadUrls(token, fileName) {
  const url = `https://developer.api.autodesk.com/oss/v2/buckets/${APS_BUCKET}/objects/${fileName}/signeds3upload?minutesExpiration=60`;
  const resp = await axios.get(url, {
    headers: { Authorization: `Bearer ${token}` }
  });
  return resp.data;
}

// Upload file to S3 using signed URL
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

// Request translation to SVF format
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

// Poll translation manifest until complete or timeout
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

// Get metadata JSON from Model Derivative API
async function getMetadata(token, urn) {
  const resp = await axios.get(
    `https://developer.api.autodesk.com/modelderivative/v2/designdata/${urn}/metadata`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  return resp.data;
}

// Get all properties for a given urn by fetching each metadata guid's properties, merging all to get all possible info (dimensions, materials, etc)
async function getAllProperties(token, urn) {
  const metadata = await getMetadata(token, urn);
  if (!metadata.data || !metadata.data.metadata) {
    throw new Error('No metadata found');
  }
  let allProperties = [];
  for (const meta of metadata.data.metadata) {
    const guid = meta.guid;
    const resp = await axios.get(
      `https://developer.api.autodesk.com/modelderivative/v2/designdata/${urn}/metadata/${guid}/properties`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (resp.data.data && resp.data.data.collection) {
      allProperties = allProperties.concat(resp.data.data.collection);
    }
  }
  return allProperties;
}

// Serve homepage with embedded extraction result & JSON container
app.get('/', async (req, res) => {
  const readmeHTML = await getReadmeHTML();

  const optionsHtml = RVT_FILES.map(
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
        pre { white-space: pre-wrap; max-height: 400px; overflow-y: auto; background: #f1f1f1; padding: 10px; }
      </style>
      <title>RVT Metadata Extractor</title>
    </head>
    <body>
      <div class="container">

        <div class="border rounded p-3 bg-white" style="max-height: 400px; overflow-y: auto; width: 58vw;">
          ${readmeHTML}
        </div>

        <section id="extract-form" class="mb-5">
          <h2>Select a RVT file</h2>
          <form id="extractForm" class="mb-3">
            <div class="mb-3">
              <select id="rvtfile" name="rvtfile" class="form-select" required>
                <option value="" disabled selected>Select a file...</option>
                ${optionsHtml}
              </select>
            </div>
            <button type="submit" class="btn btn-primary">Extract Metadata</button>
          </form>
          <div id="statusMessage" class="mb-3"></div>
        </section>

        <section id="downloads" class="mb-5">
          <h2>Download Metadata Files</h2>
          <p><a href="/downloads" class="btn btn-outline-secondary">View All Metadata JSON Files</a></p>
        </section>

        <section id="jsonOutput" style="white-space: pre-wrap; background:#eee; padding:15px; border-radius:5px; max-height: 500px; overflow-y: auto;">
          <!-- JSON metadata will be displayed here -->
        </section>

        <footer>
          &copy; 2025 Aashay Zende | aashayzende@gmail.com
        </footer>
      </div>

      <script>
        const form = document.getElementById('extractForm');
        const statusDiv = document.getElementById('statusMessage');
        const jsonOutput = document.getElementById('jsonOutput');

        form.addEventListener('submit', async (e) => {
          e.preventDefault();
          statusDiv.textContent = 'Extracting metadata... please wait.';
          jsonOutput.textContent = '';

          const formData = new FormData(form);
          const rvtfile = formData.get('rvtfile');

          try {
            const resp = await fetch('/extract', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({ rvtfile })
            });
            if (!resp.ok) {
              const errorText = await resp.text();
              statusDiv.textContent = 'Error during extraction: ' + errorText;
              return;
            }
            const data = await resp.json();
            statusDiv.innerHTML = \`Metadata extraction completed for <strong>\${rvtfile}</strong>! Download: <a href="\${data.downloadLink}" target="_blank">JSON file</a>\`;
            // Pretty print JSON output below
            jsonOutput.textContent = JSON.stringify(data.metadata, null, 2);
          } catch (err) {
            statusDiv.textContent = 'Error: ' + err.message;
          }
        });
      </script>
    </body>
    </html>
  `);
});

// List all JSON metadata files for download
app.get('/downloads', async (req, res) => {
  const files = await fs.readdir(OUTPUT_JSON_DIR);
  const links = files
    .map(f => `<li><a href="/download/${encodeURIComponent(f)}">${f}</a></li>`)
    .join('\n');
  res.send(`
    <div style="max-width:600px; margin:auto; padding:20px;">
      <h1>Metadata JSON files</h1>
      <ul>${links}</ul>
      <p><a href="/">Back to Home</a></p>
    </div>
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
      return res.status(400).json({ error: 'Invalid file selected' });
    }

    const token = await getAccessToken();
    await createBucket(token);

    if (selectedFile === 'all') {
      let mergedMetadata = { data: { metadata: [], properties: [] } };

      for (const fileName of RVT_FILES.filter(f => f !== 'all')) {
        const filePath = path.join(__dirname, fileName);
        if (!fs.existsSync(filePath)) {
          console.warn(`File not found: ${fileName}, skipping.`);
          continue;
        }

        const signedUpload = await getSignedUploadUrls(token, fileName);
        await uploadToS3(signedUpload.urls, filePath);

        const objectId = await finalizeUpload(token, fileName, signedUpload.uploadKey);
        const urn = await translateFile(token, objectId);

        await waitForTranslation(token, urn);

        const metadata = await getMetadata(token, urn);

        mergedMetadata.data.metadata.push(...(metadata.data.metadata || []));

        const props = await getAllProperties(token, urn);
        mergedMetadata.data.properties = mergedMetadata.data.properties.concat(props);
      }

      const safeFileName = 'all_rvts_metadata_full.json';
      const outputFilePath = path.join(OUTPUT_JSON_DIR, safeFileName);
      await fs.writeJson(outputFilePath, mergedMetadata, { spaces: 2 });

      // Respond with JSON (metadata + download link)
      return res.json({
        message: 'Extraction completed for all files',
        metadata: mergedMetadata,
        downloadLink: `/download/${encodeURIComponent(safeFileName)}`
      });
    } else {
      const filePath = path.join(__dirname, selectedFile);
      if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: 'Selected RVT file not found on server' });
      }

      const signedUpload = await getSignedUploadUrls(token, selectedFile);
      await uploadToS3(signedUpload.urls, filePath);

      const objectId = await finalizeUpload(token, selectedFile, signedUpload.uploadKey);
      const urn = await translateFile(token, objectId);

      await waitForTranslation(token, urn);

      const metadata = await getMetadata(token, urn);

      const allProperties = await getAllProperties(token, urn);

      const fullMetadata = {
        data: {
          metadata: metadata.data.metadata || [],
          properties: allProperties
        }
      };

      const safeFileName = selectedFile.replace(/[^a-z0-9]/gi, '_').toLowerCase() + '_full.json';
      const outputFilePath = path.join(OUTPUT_JSON_DIR, safeFileName);

      await fs.writeJson(outputFilePath, fullMetadata, { spaces: 2 });

      return res.json({
        message: `Extraction completed for ${selectedFile}`,
        metadata: fullMetadata,
        downloadLink: `/download/${encodeURIComponent(safeFileName)}`
      });
    }
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
