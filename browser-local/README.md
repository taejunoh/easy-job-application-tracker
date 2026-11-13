# Easy Job browser edition

Easy Job is a browser-only job application tracker. Enter applications manually, switch between list, board, and calendar views, and compare a saved resume with a pasted job description. The tracker runs from static files. It requires no database, account, API keys, browser extension, or AI service.

## Run locally

Use Node.js 22.13 or later in the 22.x series, or Node.js 24 or later.

```sh
cd browser-local
npm ci
npm run dev
```

Open the loopback URL that Vite prints. Use the same address and port each time to access the same saved data.

## Build and host

```sh
cd browser-local
npm ci
npm run build
npm run preview
```

Preview the production build using the URL Vite prints. Publish the full contents of `browser-local/dist/` to any HTTPS static host. Keep the asset directories alongside `index.html`. Relative asset URLs support hosting under a path such as `/jobs/`. No API routes or server-side configuration are needed. Use a dedicated hostname to isolate this tracker's browser storage from other applications. Serve the files over HTTP or HTTPS, since browser module and worker loading require an origin.

### Cloudflare Pages

The public browser edition is hosted at `https://easy-job-application-tracker.pages.dev/` as a Direct Upload project. The Cloudflare workflow builds and tests this app and deploys the static output after changes reach `main`; pull requests do not deploy it. It uses no production database. This project uses Cloudflare's free static hosting; consult Cloudflare's current limits before increasing deployment frequency or adding paid features.

To enable the workflow, a repository administrator must store `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` as GitHub Actions secrets. Create a dedicated Cloudflare token with Account → Cloudflare Pages → Edit permission restricted to the intended Cloudflare account, and keep the token private. Cloudflare's Pages Edit permission is account-scoped, so protect it accordingly. The token is used by GitHub Actions, not included in the app or its backups. Follow [Cloudflare's Direct Upload CI guide](https://developers.cloudflare.com/pages/how-to/use-direct-upload-with-continuous-integration/) for the current setup steps. After merging the workflow, verify a successful run and the public site; a failed deployment leaves the previous site available. The workflow can also be run manually from `main`.

### GitHub Pages

The **Browser-local Pages** workflow is prepared for manual publication from `main`. It builds this standalone app and publishes only `browser-local/dist/`; it does not use the production database or change the existing Vercel application. Merging the workflow does not publish the site.

After the workflow is merged and publication is authorized:

1. In the repository's **Settings → Pages**, select **GitHub Actions** as the build and deployment source.
2. In **Actions → Browser-local Pages**, choose **Run workflow**, select `main`, and run it.
3. Check that the run succeeded and open the Pages URL shown in the deployment. For this repository, the default project URL is expected to be `https://taejunoh.github.io/easy-job-application-tracker/`; use the URL reported by GitHub if it differs.
4. Test a fictional application and a backup on the published site. Repeat the manual workflow after future changes when a new public version is desired.

GitHub Pages is a separate origin from the existing site and other local addresses: it starts with an empty browser store and does not migrate existing applications. Export and import a backup explicitly if desired. Anyone who can access a backup can read the information in it. Clearing site data deletes the local store.

## Data and backups

Applications and resume text are saved in IndexedDB in the current browser profile for this origin. Clearing site data or changing the browser profile, hostname, protocol, or port can make that data unavailable. Export a JSON backup to move it to another browser or keep a copy. A backup contains application details and resume text, so keep it private. Restoring a backup replaces the data in the current browser after you confirm. The tracker keeps its JSON backups within 32 MiB. If a save would exceed that limit, shorten the new text or download a backup before deleting records you no longer need.

Resume import accepts UTF-8 TXT and unlocked PDFs with selectable text. Files can be up to 5 MB and PDFs can be up to 100 pages. PDF extraction runs in a browser worker using assets from the same host. For scanned PDFs, paste the text or use a TXT file. Only the resume text is saved. The original file remains on your device.
