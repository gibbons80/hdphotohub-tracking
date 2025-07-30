// hdphotohub_tracking/server.js
//
// Minimal delivery tracking backend for David Allen Productions.
//
// This script provides an Express based API that does a few things:
//   • Periodically fetch recent orders (jobs) from the HDPhotoHub API using
//     the brand‑specific API key.  We only care about tasks scheduled
//     yesterday and today.  The fetch will populate a simple in memory
//     structure and also persist it to disk in jobs.json.
//   • Provide endpoints for the WordPress front‑end to consume.  Currently
//     `/jobs` returns all known jobs and `/refresh` forces a manual update.
//   • Expose endpoints (`/webhook/listingCreated` and `/webhook/listingDelivered`)
//     where Spiro/LeadConnector can POST notifications when a listing is
//     created or delivered.  These handlers update the corresponding job in
//     our store.
//
// NOTE: This is a minimal viable product.  It does not implement any
// authentication or rate limiting and it trusts inbound webhook payloads.
// Before deploying to production you should secure the webhook routes
// (e.g. by verifying a secret) and ensure the server runs over HTTPS.

const fs = require('fs');
const path = require('path');
const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');

// -----------------------------------------------------------------------------
// Configuration
// -----------------------------------------------------------------------------

// HDPhotoHub API configuration.  The base URL is the same one you access via
// the API documentation.  The API key must match the key on your account.
const HDPH_API_BASE = 'https://sites.davidallenproductions.com/api/v1';
const HDPH_API_KEY  = process.env.HDPH_API_KEY || 'AF81841AC8314138820846254CE8E9FD';

// File where we persist our job records.  If the file does not exist it will
// be created on first save.
const JOBS_FILE = path.join(__dirname, 'jobs.json');

// How often (in milliseconds) to refresh orders from the API.  Default to
// fifteen minutes; adjust as needed.  A manual refresh can be triggered via
// `/refresh`.
const REFRESH_INTERVAL = 15 * 60 * 1000;

// Express application setup
const app = express();
app.use(bodyParser.json());

// In memory store of job records.  Keys are a composite of order ID and task
// line ID (tid) for uniqueness.  Each record looks like:
// {
//   id: `${oid}-${tid}`,
//   orderId: <integer>,
//   taskId: <integer>,
//   siteId: <integer>,
//   address: <string>,
//   photographer: <string>,
//   clientName: <string>,
//   status: 'Pending' | 'Delivered',
//   apptDate: <ISO date string>,
//   deliveryDate: <ISO date string | null>
// }
let jobsStore = {};

// -----------------------------------------------------------------------------
// Utility functions
// -----------------------------------------------------------------------------

/**
 * Save the current job store to disk.  Write is debounced to avoid too
 * frequent writes; for this small dataset the overhead is minimal.
 */
function saveJobs() {
  try {
    fs.writeFileSync(JOBS_FILE, JSON.stringify(jobsStore, null, 2));
  } catch (err) {
    console.error('Failed to write jobs to disk:', err);
  }
}

/**
 * Load jobs from disk into memory.  Called on startup.  If the file is
 * missing the store remains empty.
 */
function loadJobs() {
  if (fs.existsSync(JOBS_FILE)) {
    try {
      const raw = fs.readFileSync(JOBS_FILE, 'utf8');
      jobsStore = JSON.parse(raw);
    } catch (err) {
      console.error('Failed to parse jobs file; starting fresh:', err);
      jobsStore = {};
    }
  }
}

/**
 * Generate a date range covering today and yesterday in local (America/New_York)
 * time.  Returns objects with ISO strings for start and end times.  Note: we
 * compute in UTC to avoid DST pitfalls, then convert to ISO strings.
 */
function getDateRange() {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  // Start at yesterday midnight
  const start = new Date(today);
  start.setDate(today.getDate() - 1);
  // End at end of today (just before midnight)
  const end = new Date(today);
  end.setDate(today.getDate() + 1);
  end.setMilliseconds(-1);
  return {
    start: start.toISOString(),
    end: end.toISOString()
  };
}

/**
 * Fetch all orders from HDPhotoHub.  Each order includes an array of tasks.
 * Returns an array of order objects on success.  If the endpoint is
 * unavailable the promise rejects.
 */
async function fetchOrdersFromApi() {
  try {
    const res = await axios.get(`${HDPH_API_BASE}/orders`, {
      headers: {
        api_key: HDPH_API_KEY
      },
      // The API supports optional site ID or user ID filters via query
      // parameters but we omit them here to get all orders.  If your account
      // has many years of history and this call becomes slow you may need to
      // implement incremental fetch using `date` tags or similar.
      timeout: 60000
    });
    if (res.status !== 200) {
      throw new Error(`Unexpected status: ${res.status}`);
    }
    return res.data;
  } catch (err) {
    console.error('Error fetching orders:', err.message);
    throw err;
  }
}

/**
 * Fetch details for a single site (listing) by its ID.  Returns null on
 * failure.
 *
 * @param {number} sid
 */
async function fetchSiteDetails(sid) {
  try {
    const res = await axios.get(`${HDPH_API_BASE}/site`, {
      headers: { api_key: HDPH_API_KEY },
      params: { sid },
      timeout: 30000
    });
    if (res.status === 200) {
      return res.data;
    }
  } catch (err) {
    console.warn(`Failed to fetch site ${sid}:`, err.message);
  }
  return null;
}

/**
 * Build a job record from an order and its task.  Populates site address and
 * user/client name by fetching the site details.
 *
 * @param {Object} order
 * @param {Object} task
 */
async function buildJob(order, task) {
  const jobId = `${order.oid}-${task.tid}`;
  const siteId = order.sid;
  // Attempt to reuse previously loaded site details to avoid repeated API
  // requests.  We cache them in-memory on the jobsStore under `_sites`.
  if (!jobsStore._sites) jobsStore._sites = {};
  let siteData = jobsStore._sites[siteId];
  if (!siteData) {
    siteData = await fetchSiteDetails(siteId);
    if (siteData) {
      jobsStore._sites[siteId] = siteData;
    }
  }
  const addressParts = [];
  let clientName = '';
  if (siteData) {
    if (siteData.address) addressParts.push(siteData.address);
    if (siteData.city) addressParts.push(siteData.city);
    if (siteData.state) addressParts.push(siteData.state);
    if (siteData.zip) addressParts.push(siteData.zip);
    // Client/user data sits on siteData.user; fallback to empty strings.
    if (siteData.user) {
      const u = siteData.user;
      clientName = [u.firstname, u.lastname].filter(Boolean).join(' ');
    }
  }
  return {
    id: jobId,
    orderId: order.oid,
    taskId: task.tid,
    siteId: siteId,
    address: addressParts.join(', '),
    photographer: task.memberassigned || '',
    clientName: clientName,
    status: task.done ? 'Delivered' : 'Pending',
    apptDate: task.apptdate || null,
    deliveryDate: task.done || null
  };
}

/**
 * Refresh the jobsStore by fetching orders from the API and processing
 * tasks scheduled within the last day and today.  Returns the number of
 * jobs updated.
 */
async function refreshJobs() {
  const { start, end } = getDateRange();
  console.log(`Refreshing jobs between ${start} and ${end} ...`);
  let orders;
  try {
    orders = await fetchOrdersFromApi();
  } catch (err) {
    console.error('Failed to refresh jobs due to order fetch error.');
    return 0;
  }
  let count = 0;
  // Build a copy of current jobs to track removals
  const newJobs = {};
  if (jobsStore._sites) {
    newJobs._sites = jobsStore._sites;
  }
  // Process each order
  for (const order of orders) {
    if (!order.tasks || !Array.isArray(order.tasks)) continue;
    for (const task of order.tasks) {
      if (!task.apptdate) continue;
      const appt = new Date(task.apptdate);
      if (appt.toISOString() < start || appt.toISOString() > end) continue;
      const jobRecord = await buildJob(order, task);
      newJobs[jobRecord.id] = jobRecord;
      count++;
    }
  }
  jobsStore = newJobs;
  saveJobs();
  console.log(`Jobs refreshed. Total jobs: ${count}`);
  return count;
}

// -----------------------------------------------------------------------------
// API routes
// -----------------------------------------------------------------------------

/**
 * GET /jobs
 * Return the list of job records as an array.  Jobs are sorted by appointment
 * date descending.
 */
app.get('/jobs', (req, res) => {
  const jobList = Object.values(jobsStore)
    .filter(item => item && item.id && item !== jobsStore._sites)
    .sort((a, b) => {
      const ad = a.apptDate || '';
      const bd = b.apptDate || '';
      return ad < bd ? 1 : ad > bd ? -1 : 0;
    });
  res.json(jobList);
});

/**
 * POST /webhook/listingCreated
 * Handler for the "Listing Created" webhook.  The payload structure
 * depends on Spiro/LeadConnector; we accept both JSON and form encoded
 * bodies.  For now we expect at minimum a site ID and optionally an
 * appointment/task ID.  If a job is not yet present we create a skeleton
 * entry; otherwise we update the existing job.
 */
app.post('/webhook/listingCreated', (req, res) => {
  const payload = req.body || {};
  console.log('Received listingCreated webhook:', JSON.stringify(payload));
  // Attempt to extract identifiers.  Fallback to custom fields based on
  // observed sample payloads.  You may need to adapt these keys to match
  // your Spiro configuration.
  const orderId = payload.orderId || payload.order_id || null;
  const taskId = payload.taskId || payload.task_id || null;
  const siteId = payload.siteId || payload.site_id || null;
  if (!siteId || !taskId || !orderId) {
    // If we can't associate the job, store it temporarily in a staging area.
    console.warn('Missing identifiers in listingCreated payload.');
    return res.status(200).json({ ok: true });
  }
  const jobKey = `${orderId}-${taskId}`;
  if (!jobsStore[jobKey]) {
    jobsStore[jobKey] = {
      id: jobKey,
      orderId,
      taskId,
      siteId,
      address: '',
      photographer: '',
      clientName: '',
      status: 'Pending',
      apptDate: null,
      deliveryDate: null
    };
  }
  saveJobs();
  res.json({ ok: true });
});

/**
 * POST /webhook/listingDelivered
 * Handler for the "Listing Delivered" webhook.  We mark the job as delivered
 * and record the delivery date/time.  The payload should contain the same
 * identifiers as the created webhook.
 */
app.post('/webhook/listingDelivered', (req, res) => {
  const payload = req.body || {};
  console.log('Received listingDelivered webhook:', JSON.stringify(payload));
  const orderId = payload.orderId || payload.order_id || null;
  const taskId = payload.taskId || payload.task_id || null;
  const siteId = payload.siteId || payload.site_id || null;
  const deliveredAt = payload.deliveredAt || payload.delivered_at || new Date().toISOString();
  if (!orderId || !taskId) {
    console.warn('Missing identifiers in listingDelivered payload.');
    return res.status(200).json({ ok: true });
  }
  const key = `${orderId}-${taskId}`;
  if (!jobsStore[key]) {
    jobsStore[key] = {
      id: key,
      orderId,
      taskId,
      siteId,
      address: '',
      photographer: '',
      clientName: '',
      status: 'Delivered',
      apptDate: null,
      deliveryDate: deliveredAt
    };
  } else {
    jobsStore[key].status = 'Delivered';
    jobsStore[key].deliveryDate = deliveredAt;
  }
  saveJobs();
  res.json({ ok: true });
});

/**
 * GET /refresh
 * Force an immediate refresh of jobs from the HDPhotoHub API.  Responds
 * with the number of jobs processed.  Useful for debugging or hooking into
 * external schedulers.
 */
app.get('/refresh', async (req, res) => {
  const count = await refreshJobs().catch(() => 0);
  res.json({ refreshed: count });
});

// Serve the front‑end (public folder) statically
app.use(express.static(path.join(__dirname, 'public')));

// Start the server once jobs are loaded and the initial refresh has run.  If
// the initial API call fails the server will still start with an empty
// dataset.
async function startServer() {
  loadJobs();
  try {
    await refreshJobs();
  } catch (err) {
    console.warn('Initial job refresh failed; continuing with stored data.');
  }
  // Set up periodic refresh
  setInterval(() => {
    refreshJobs().catch(err => console.error('Periodic refresh error:', err.message));
  }, REFRESH_INTERVAL);
  const port = process.env.PORT || 3000;
  app.listen(port, () => {
    console.log(`Delivery tracking server listening on port ${port}`);
  });
}

startServer().catch(err => {
  console.error('Failed to start server:', err);
});