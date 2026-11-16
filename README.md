# JG Hub

Personal home screen for Dr. Jessica Greenberg (Greenie). Static site for GitHub Pages at `jg.drgreenie.com`.

The page is publicly reachable by URL once published. Tiles are only links. There is no authentication and no secrets on the page. Search engines are asked not to index it (`robots.txt` + `noindex`).

## Publish on GitHub Pages

The Cursor GitHub connector cannot create repositories, push files, or enable Pages. Do this once in the GitHub website, signed in as `orthoalien`:

1. Create a **public** repository named `jg-hub` (New repository at https://github.com/new). Public is required for free GitHub Pages. Do not initialize with a README if you will upload these files first.
2. Upload `index.html`, `styles.css`, `app.js`, `CNAME`, and `robots.txt` to the `main` branch root (or push this folder).
3. Open **Settings → Pages**.
4. Under **Build and deployment**, set **Source** to **Deploy from a branch**, **Branch** to **main**, folder to **/ (root)**, then click **Save**.
5. Under **Custom domain**, enter `jg.drgreenie.com` and save. DNS should already be a CNAME of `jg` → `orthoalien.github.io`.
6. When GitHub finishes the TLS certificate (often after DNS has settled), check **Enforce HTTPS**.

The site should then be available at https://jg.drgreenie.com and https://orthoalien.github.io/jg-hub/.
