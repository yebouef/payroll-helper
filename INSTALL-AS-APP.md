# Install Payroll Helper as an app

The app is now an installable **PWA** — it gets a real app icon and its own window on
both Mac and phone, and works offline. Your hours and pay data never leave the device;
nothing is uploaded.

Everything you need is in the **`site`** folder. To put it on another computer, copy that
whole folder.

---

## Mac — install as an offline app (no internet)

1. Open the `site` folder and **double-click `Start Payroll Helper.command`**.
   - First time only: macOS may say it "cannot be opened." **Right-click the file → Open → Open.**
     You only do this once.
2. A small Terminal window opens and your browser loads the app at `http://localhost:8765`.
   Leave that Terminal window open while installing.
3. **In Chrome or Edge:** click the **Install icon** in the address bar (a small monitor with a
   down-arrow, on the right side) → **Install**.
   **In Safari:** menu **File → Add to Dock**.
4. The app now lives in your Applications/Dock as **"Payroll"** and opens in its own window.
   After install it works **offline** — you can close the Terminal window.
   (If it ever won't open, just double-click `Start Payroll Helper.command` again.)

*Simplest fallback (no Terminal):* open `payroll-helper.html` in Chrome →
menu **⋮ → Cast, save, and share → Create shortcut → check "Open as window."*
This gives an app window too, but without offline caching.

---

## Phone — add to the home screen

A phone can't reach your Mac, so the phone version needs the app to be **hosted at a private
web address** (see the next section). Once it's hosted:

- **iPhone (Safari):** open the private URL → tap **Share** → **Add to Home Screen** → **Add**.
- **Android (Chrome):** open the private URL → menu **⋮** → **Install app** / **Add to Home screen**.

The icon opens full-screen like a normal app and works offline after the first load.

---

## Private hosting for the phone (free, locked to your emails)

Use **Cloudflare Pages + Access** so only you and your 1–2 coworkers can open it.

1. Make a free account at **dash.cloudflare.com**.
2. **Workers & Pages → Create → Pages → Upload assets.** Drag in **everything inside the `site`
   folder**. Click **Deploy.** You get a URL like `payroll-helper.pages.dev`.
3. Lock it down: **Zero Trust → Access → Applications → Add an application → Self-hosted.**
   - Application domain: your `*.pages.dev` URL.
   - Policy: **Allow**, rule **Emails** = your address(es).
   - Save. Now opening the URL emails a one-time code; only approved emails get in.

**The app now ships blank — no client names are in the code.** Each person adds their own
clients and rates on their own device (Rule Library → **+ Add client** → set **Regular $/hr**, and
a **Night $/hr** for 11pm–7am if the client has one). Uploading a Brittco PDF also auto-adds any
clients it finds, ready for you to price. So the hosted files contain nothing identifying.

**Sharing a setup (admin).** Configure your clients once, then Rule Library → **Export starter**
to save `payroll-starter.json`. Send that file to a coworker; they open the app and use
**Import starter…** to load the same clients. (Your own setup is saved at the project root as
`payroll-starter.json` — import it on your phone to get going instantly.)

---

## Moving your data between devices

Each device keeps its **own** history (stored in that browser). They don't sync. To move a pay
period from one device to another, use **Export JSON** on the first device and load that file on
the second. Export is also your backup if you ever clear the browser.
