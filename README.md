# Payroll Helper

A review-first payroll helper that runs entirely in your browser. Upload a Brittco
attendance PDF and it extracts your shifts, calculates pay (regular hours plus a
separate 11pm–7am night rate), and drafts the pay email for you to review and send.

- **No server, no accounts.** All processing and storage happen in your browser
  (localStorage). The PDF you upload never leaves your device.
- **Starts blank.** Each person adds their own clients and rates.
- **Review-first.** It never auto-sends; it drafts the email for you to check.

## Run it

- Open `payroll-helper.html` in a browser, **or**
- Host these files (e.g. GitHub Pages) and open the URL on any device.

See `INSTALL-AS-APP.md` for installing it as an app on Mac or phone.

## Privacy

Your hours, rates, and pay data stay on your device. Hosting this code only serves
the app files — it never sees your data. Use the in-app **Export JSON** to back up
or move your data between devices.
