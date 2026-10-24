# Google login credentials

For the current Mac setup, use `http://localhost:3000`. Open Google Cloud in your
normal browser, where you are already signed in.

1. Open [Google Cloud Console](https://console.cloud.google.com/), select your
   existing project or create one named **Meta Harness**.
2. Open **Google Auth Platform**. Complete **Get started** if prompted:
   app name **Meta Harness**, your email for support/contact, audience **External**.
   Under **Audience**, keep it in **Testing** and add
   `tomas.piaggio12@gmail.com` under **Test users**.
   [Google's consent setup guide](https://developers.google.com/workspace/guides/configure-oauth-consent).
3. Open **Clients → Create client**. Select **Web application**, name it
   **Meta Harness Local**, and add this exact **Authorized redirect URI**:

   ```text
   http://localhost:3000/api/auth/callback/google
   ```

   Authorized JavaScript origins can stay empty for this server-side flow.
4. Click **Create**. Save the **Client ID** and **Client secret** immediately;
   optionally download the JSON while the creation dialog is open. Google only
   shows the secret at creation. Keep the secret/JSON outside git and chat.
   [Google's client creation guide](https://support.google.com/cloud/answer/15549257?hl=en).
5. Add/update these values in the existing project-root `.env`:

   ```dotenv
   HARNESS_AUTH=google
   HARNESS_PUBLIC_URL=http://localhost:3000
   HARNESS_OWNER_EMAILS=tomas.piaggio12@gmail.com
   GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=your-client-secret
   ```

   Keep the existing `BETTER_AUTH_SECRET`. Only if it is missing, generate one
   with `openssl rand -base64 32` and save it as `BETTER_AUTH_SECRET` in `.env`.
   Do not replace the rest of `.env` or rotate an existing secret. Restrict the
   file with `chmod 600 .env`.
6. After active turns finish, restart the existing control server using its
   current launcher, then open
   [http://localhost:3000/login](http://localhost:3000/login) and click
   **Continue with Google**. Sign in as `tomas.piaggio12@gmail.com`.
   Avoid starting a second server on port 3000; no rebuild is needed for env changes.

If Google reports `redirect_uri_mismatch`, compare the complete callback URL,
including `http`, `localhost`, port `3000`, and `/api/auth/callback/google`.

When moving to the Pi, add a callback on your owned HTTPS domain and update
`HARNESS_PUBLIC_URL` to that origin. Google requires HTTPS and a public DNS suffix
outside the localhost exception: `macbook.tomhom` and `server.tomhom` are not
suitable callback names. The service itself can stay private on the tailnet.
[Google's redirect URI rules](https://support.google.com/cloud/answer/15549257?hl=en).

This configures owner sign-in. Gmail, Drive and other integration permissions have
separate consent; logging into the harness does not grant those automatically.
