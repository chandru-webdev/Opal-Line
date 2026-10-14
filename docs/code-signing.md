# Windows code-signing runbook (SmartScreen)

Every installer this repo ships is Authenticode-signed, but with a **self-signed**
certificate. Windows therefore treats the installer as unsigned: SmartScreen shows
"Windows protected your PC" on first run, and browsers/email gateways often block
the download. The fix is a code-signing certificate from a public CA. This
runbook is the exact path from "cert purchased" to "signed release published".

## 1. Buy the right certificate

- **EV code-signing** — SmartScreen reputation is granted immediately.
- **OV code-signing** — cheaper; SmartScreen reputation accumulates over weeks
  of downloads. Choose this if budget matters more than day-one reputation.
- Vendors: DigiCert, SSL.com, Sectigo, GlobalSign (all deliver as a PFX/`.p12`
  into the buyer's browser or HSM — request **PKCS#12 export**, not a cloud
  signing plan; the release workflow signs on a CI runner and needs the file).

**Subject requirement (critical):** the certificate subject must contain the
string `Opal Line Billing` — normally as the organization name
(`O=Opal Line Billing`). Three places enforce it, and a cert with any other
legal name will fail the build or brick auto-updates:

1. `electron/electron-builder.yml` — build refuses without that subject;
2. `.github/workflows/release.yml` — import step rejects other subjects;
3. `electron/main.ts` (`verifyInstallerSignature`) — the **updater** on every
   user's machine rejects downloaded updates whose signer subject lacks it.

If the company's registered legal name differs from "Opal Line Billing", decide
the canonical string *before buying* and update all three places in one PR.

## 2. Import the PFX on the machine that holds the cert

```powershell
Import-PfxCertificate -FilePath path\from\vendor.pfx `
  -CertStoreLocation Cert:\CurrentUser\My -Password (Read-Host 'PFX password' -AsSecureString)
```

Confirm it landed:

```powershell
Get-ChildItem Cert:\CurrentUser\My | Where-Object Subject -like '*Opal Line Billing*' |
  Format-List Subject, Thumbprint, NotAfter
```

## 3. Export it for GitHub Actions

Preferred (repo script — re-exports with an empty password, writes both the
binary PFX and a base64 file, and prints the next command):

```powershell
powershell -NoProfile -File scripts/export-signing-pfx.ps1
```

Manual equivalent:

```powershell
Export-PfxCertificate -Cert Cert:\CurrentUser\My\<thumbprint> -FilePath code-signing.pfx -Password (ConvertTo-SecureString '' -AsPlainText -Force)
[Convert]::ToBase64String([IO.File]::ReadAllBytes('code-signing.pfx')) | Set-Content code-signing.b64
```

## 4. Store the secret in the repository

With the GitHub CLI:

```bash
gh secret set WIN_SIGNING_PFX_B64 -f dist-electron/code-signing.b64
```

Without `gh` (REST + libsodium sealed box):

```bash
npm install --no-save libsodium-wrappers
GH_TOKEN=$(printf 'protocol=https\nhost=github.com\n\n' | git credential fill | sed -n 's/^password=//p') \
  node scripts/set-gh-secret.mjs WIN_SIGNING_PFX_B64 dist-electron/code-signing.b64
```

`WIN_SIGNING_PFX_PASSWORD` is only needed if you exported the PFX with a
non-empty password; the repo scripts export with an empty password, so leaving
the secret unset is normal.

## 5. Cut a signed build

Any `v*` tag runs the Release workflow; it fails fast when the secret is
missing, so nothing unsigned ships by accident. To re-build an **existing**
tag with the new cert (e.g. re-sign v1.0.21), use *Actions → Release → Run
workflow* and select the tag — `workflow_dispatch` supports it. Assets are
replaced; already-installed copies stay on their version (updates are
version-compared, not digest-compared), and all future downloads use the new
asset and its new digest automatically.

## 6. Verify

```powershell
$sig = Get-AuthenticodeSignature .\Opal.Line.Billing-Setup-<ver>.exe
$sig.Status                     # expect: Valid
$sig.SignerCertificate.Subject  # must contain: Opal Line Billing
$sig.SignerCertificate.Issuer -eq $sig.SignerCertificate.Subject   # expect: False (self-signed was True)
```

On a clean machine (fresh user profile, never saw the cert), double-click the
installer: SmartScreen's warning should be gone for an EV cert immediately, or
after reputation accrues for OV. The app's own updater performs the same
signature check at download time — watch `app.log` for
`[update] verified update <ver> at ...` on the first update cycle after the
switch.

## Current state

- Releases are signed with a **self-signed** subject `Opal Line Billing` cert;
  `release.yml` prints a loud `SMARTSCREEN` banner while that remains true.
- Purchasing the CA certificate (step 1) is the only manual gate; steps 2–6
  take about 15 minutes once the PFX is in hand.
