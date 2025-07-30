# Delivery Tracking System for David Allen Productions

This folder contains a minimal example of how you can integrate the HDPhotoHub
API with a custom dashboard in WordPress.  The solution is divided into a
backend (an Express server) and a frontend (a simple HTML page using
TailwindCSS and Chart.js).  Together, they provide a real‑time view of
listings/jobs created yesterday and today, along with their delivery status.

## Contents

* `server.js` – Node/Express backend that fetches jobs from the HDPhotoHub API,
  exposes them over `/jobs`, handles incoming webhooks from Spiro/LeadConnector
  and persists data in `jobs.json`.
* `jobs.json` – A simple JSON database used to persist job records across
  restarts.  It is safe to delete this file; it will be recreated on the next
  refresh.
* `public/index.html` – Frontend page styled with TailwindCSS.  It fetches
  job data from the backend, displays it in a table and renders a doughnut
  chart showing the ratio of delivered vs pending jobs.

## Running the backend

1. Ensure you have [Node.js](https://nodejs.org/) installed.
2. In the `hdphotohub_tracking` directory run:

   ```bash
   npm install
   node server.js
   ```

   The server will start on port `3000`.  It will immediately attempt to
   refresh job data from HDPhotoHub using the API key provided in
   `server.js` (or the `HDPH_API_KEY` environment variable if set).  The
   initial refresh may take some time depending on how many orders your
   account has.  If the `/orders` endpoint is not enabled for your account
   you may need to contact HDPhotoHub support.

3. Navigate to `http://localhost:3000` in your browser to view the dashboard.

4. To test the webhook endpoints locally you can send a POST request to
   `http://localhost:3000/webhook/listingCreated` or
   `http://localhost:3000/webhook/listingDelivered` with a JSON body
   containing at minimum `orderId`, `taskId` and `siteId` (for created) and
   `deliveredAt` (for delivered).  The script is designed to be flexible:
   adjust the payload key names in `server.js` if your Spiro payload differs.

## Deploying to WordPress

* **Hosting:** Host the Express backend on the same server that runs your
  WordPress site or on a small VPS (e.g. a DigitalOcean droplet).  Make sure
  the server is reachable from the internet so that HDPhotoHub and Spiro
  webhooks can call it.

* **Webhooks:** Configure two webhooks in your Spiro/LeadConnector account
  pointing to `https://<your‑domain>/webhook/listingCreated` and
  `https://<your‑domain>/webhook/listingDelivered`.  This will allow
  real‑time updates when listings are created or delivered.

* **Embedding the dashboard:** Create or edit a WordPress page (e.g.
  `/data‑tracking/`) and embed the dashboard using an iframe.  For example:

  ```html
  <iframe src="https://<your‑domain>/index.html" style="width:100%;height:600px;border:none;"></iframe>
  ```

  Replace `<your‑domain>` with the domain where the backend is hosted.

* **Styling:** The dashboard uses TailwindCSS via CDN.  If your WordPress
  environment already loads Tailwind or you need custom styling, you can
  modify `public/index.html` accordingly.

## Limitations & next steps

* **Error handling:** The sample backend logs errors but does not retry
  failed API calls.  Consider implementing exponential backoff and
  notification when HDPhotoHub is unreachable.
* **Authentication:** The webhook endpoints accept any payload.  In
  production you should verify a shared secret or signature to ensure
  authenticity.
* **Order API availability:** At the time of writing the `/orders` endpoint
  occasionally returns a 404 for some accounts.  If this happens the
  dashboard will display only webhook‑originated data.  HDPhotoHub may need
  to enable the endpoint for your brand.
* **Database:** For a more robust solution, replace the JSON file with a
  lightweight database such as SQLite or Postgres.

This code is intended as a starting point.  Feel free to modify and extend
it to meet your specific business needs.