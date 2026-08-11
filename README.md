# ICT Gold AI — Vercel

## Deploy with GitHub → Vercel

1. Create a new GitHub repository.
2. Upload **all files inside this folder** to the repository root.
3. In Vercel, choose **Add New Project** and import that GitHub repository.
4. Click Deploy.

No separate `api` upload is required: the `api` folder is already included in this repository and Vercel detects its serverless functions automatically.

## Thresholds

- Balanced: >= 62%
- Strict: >= 90%
- Multi / All Strategies: >= 50%
- Aggressive: >= 50%
- Manual Auto-Trade Threshold: 20%–100%

Do not delete the `api` folder; Vercel uses it for the backend endpoints.
