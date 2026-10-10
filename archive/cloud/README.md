# Nojam Archive in the cloud, for free (Oracle Cloud)

Run the archive on a free server that's always on, so your Mac, PC and iPhone can all be off. You open it from your
iPhone or Mac through [Tailscale](https://tailscale.com): a private, encrypted connection between your own devices.
Nobody else can reach your archive.

- **The server:** Oracle Cloud's *Always Free* Ampere server: up to 4 cores and 24 GB of memory, with 150 GB of disk.
  The smallest size, 1 core and 6 GB, works too.
- **Tagging:** free, by Ollama running on that server, in the background. It takes about a minute per new picture
  with 4 cores, and a few minutes with 1 core.
- **Cost:** nothing, as long as you use the settings below.
- **You need:** about 45 minutes, your Mac (with Terminal), your iPhone, and a credit or debit card. Oracle uses the
  card to check who you are.

## 1. Create an Oracle Cloud account

1. Go to [oracle.com/cloud/free](https://www.oracle.com/cloud/free/) and click **Start for free**.
2. Enter your country, name and email, and confirm the email. Then set a password and a **Cloud Account Name**.
   Write that name down: you need it every time you sign in.
3. **Home Region:** you can't change it later, and the free server can only be made there. In Korea, choose
   **South Korea North (Chuncheon)**. From anywhere in Korea it's as fast as Seoul, and it usually still has free
   Ampere servers when Seoul has run out. If no Korean region is offered, choose **Japan East (Tokyo)** or
   **Japan Central (Osaka)**; from Korea they work just as well. Elsewhere, choose the nearest region.
4. Add your address and verify your card (a small temporary charge may appear; it's refunded), then start the trial.
5. Wait for the email saying your account is ready. It can take a few minutes, sometimes longer. Sign in at
   [cloud.oracle.com](https://cloud.oracle.com) with your Cloud Account Name. The first time, Oracle may ask you to set
   up a sign-in code app, such as Oracle Mobile Authenticator.

## 2. Make sure it stays free and stays yours

Oracle can take back free servers that sit idle, and free accounts often find no Ampere servers available. Upgrading
the account to **Pay As You Go** fixes both. Always Free things stay free; you'd only pay for things beyond the free
limits, and this guide doesn't create any.

1. Open the menu (☰, top left) → **Billing & Cost Management** → **Upgrade and Manage Payment**, and upgrade to
   **Pay As You Go**. It can take a while to finish; Oracle emails you when it's done. **Wait for that email before
   step 3**: before the upgrade, creating the server very often fails with "Out of capacity".
2. Add a safety net: ☰ → **Billing & Cost Management** → **Budgets** → **Create Budget**. Choose **Monthly** and a
   budget of **1** (1 dollar, or the smallest amount in your currency). Add an alert at **100%** of actual spending,
   sent to your email. If anything ever starts to cost money, you'll know the same day.

## 3. Create the server

☰ → **Compute** → **Instances** → **Create instance**. Change only these settings:

- **Name:** `nojam-archive`
- **Image and shape:**
  - **Change shape** → **Virtual machine** → **Ampere** → tick `VM.Standard.A1.Flex`. It starts at its smallest
    size (1 core OCPU, 6 GB memory). Open the arrow (▸) next to its name to show **Number of OCPUs** and
    **Amount of memory (GB)**, set them to **4** and **24**, then click **Select shape**. It's marked
    *Always Free-eligible*. If you can't go above 1 and 6, or 4 and 24 fails with "Out of capacity", keep the smallest
    size: the setup adapts to it, and you can make the server bigger later (see *Everyday use*).
  - **Change image** → **Ubuntu** → **Canonical Ubuntu 24.04**. Pick the plain one, not "Minimal".
- **Networking:** keep **Create new virtual cloud network** and **Create new public subnet**, and keep
  **Automatically assign public IPv4 address** switched on.
- **Add SSH keys:** choose **Generate a key pair for me** and click **Save private key**. Keep this file safe: it's your
  only key to the server.
- **Boot volume:** tick **Specify a custom boot volume size** and enter **150** (GB). The free plan includes 200 GB.

Click **Create**. After a minute or two the state turns **Running**. On the instance's page, find
**Public IP address** and copy it.

> **"Out of capacity for shape VM.Standard.A1.Flex in availability domain AD-1"?** Oracle has no free Ampere servers
> left in your region at the moment. The Korean regions have only one availability domain, so you can't pick another.
> 1. Check the Pay As You Go upgrade has finished (step 2). In **Upgrade and Manage Payment**, your plan should read
>    *Pay As You Go*. This fixes it most of the time.
> 2. Try a smaller size: **2 OCPUs** and **12 GB**, or the smallest, **1 OCPU** and **6 GB**. Both are enough for the
>    archive. On a small server the setup uses a smaller tagging model and adds extra memory on disk (swap).
> 3. Try again later. Servers free up through the day, often early in the morning or late at night.

## 4. Connect to the server from your Mac

Open **Terminal** on your Mac. Paste these lines one at a time, and use your server's public IP in place of
`123.45.67.89`:

```sh
mkdir -p ~/.ssh
mv ~/Downloads/ssh-key-*.key ~/.ssh/oracle-archive.key
chmod 600 ~/.ssh/oracle-archive.key
ssh -i ~/.ssh/oracle-archive.key ubuntu@123.45.67.89
```

The first time, it asks whether to trust the server: type `yes` and press Return. You're on the server when the
prompt looks like `ubuntu@nojam-archive:~$`.

## 5. Set up the archive (one line)

On the server, paste:

```sh
curl -fsSL https://raw.githubusercontent.com/rlarlghs123/Nojam-Directors/main/archive/cloud/setup.sh | bash
```

It installs everything, starts the archive and downloads the tagging model. The first time takes 10 to 20 minutes.
Near the end it asks for two things:

1. **A Tailscale link** (`https://login.tailscale.com/a/…`). Open it on your Mac and sign in to Tailscale (free; you
   can use your Google, Apple, Microsoft or GitHub account). This connects the server to your Tailscale account.
2. **Maybe a second link**, to turn on HTTPS for your Tailscale network. If it appears, open it and approve. The
   setup continues by itself.

It ends with **Your archive: https://nojam-archive.….ts.net**. That's your archive's address.

Then do this once: in the [Tailscale admin console](https://login.tailscale.com/admin/machines), click the **…**
menu next to *nojam-archive* → **Disable key expiry**. Otherwise the server drops out of Tailscale after 180 days
until you sign it in again.

## 6. Open it on your iPhone

1. Install **Tailscale** from the App Store. Sign in with the same account and allow it to add a VPN configuration.
   Keep it switched on; it uses very little battery.
2. In Safari, open your archive's address, then tap Share → **Add to Home Screen**.

To open it on your Mac too, install Tailscale from [tailscale.com/download](https://tailscale.com/download) and sign
in the same way.

## 7. Move your current archive to the server (optional)

This copies everything from the Archive folder in your iCloud Drive. First make sure the folder is fully on your Mac:
in Finder, right-click it → **Keep Downloaded**. Then run this **on your Mac** (in a new Terminal window, not on the
server), with your server's IP:

```sh
rsync -av --exclude .DS_Store -e "ssh -i $HOME/.ssh/oracle-archive.key" \
  ~/Library/Mobile\ Documents/com~apple~CloudDocs/Archive/ ubuntu@123.45.67.89:Nojam-Directors/archive/library/
```

The archive notices the new files by itself. Their tags and descriptions come along (they're kept in the hidden
`.archive` folder), so nothing is tagged twice.

## Everyday use

- **Add things:** tap the **+** tile (on the iPhone, *Choose files* → *Photo Library*), drag and drop, or paste.
- **Update to the newest version:** connect to the server (step 4) and run the setup line again. Your files, tags and
  settings stay.
- **Change a setting:** on the server, run `nano ~/Nojam-Directors/archive/.env`. Change the line, save with
  Ctrl-O, Return, Ctrl-X, then run the setup line again. For better but slower tags, use
  `TAG_MODEL=qwen3-vl:8b-instruct`.
- **Make the server bigger** (when Oracle has room, e.g. after the Pay As You Go upgrade): in Oracle, ☰ → **Compute**
  → **Instances** → *nojam-archive* → **Edit** → **Edit shape**, raise **OCPUs** and **Memory** (up to 4 and 24),
  and **Save changes**. The server restarts and everything comes back by itself. For better tags on the bigger server,
  set `TAG_MODEL=qwen3-vl:4b-instruct` (see *Change a setting*).
- **See what it's doing:** `cd ~/Nojam-Directors/archive && sudo docker compose logs --tail 50 archive`
- **Restart everything:** `sudo reboot`. The archive and Tailscale start again by themselves.
- **Back up:** your files now live only on the server. Now and then, copy them to your Mac:

  ```sh
  rsync -av -e "ssh -i $HOME/.ssh/oracle-archive.key" ubuntu@123.45.67.89:Nojam-Directors/archive/library/ ~/Archive-backup/
  ```

## If something goes wrong

- **`Permission denied (publickey)`** when connecting: the user name must be `ubuntu`, and the key must be the file
  you saved in step 3.
- **`UNPROTECTED PRIVATE KEY FILE`**: run `chmod 600 ~/.ssh/oracle-archive.key` on your Mac.
- **The setup stopped with an error:** read the message, then run the same line again. It continues where it stopped.
- **The page doesn't open on the iPhone:** make sure Tailscale is switched on and signed in to the same account as the
  server.
- **The page says "Tagging is waiting":** the tagging model may still be downloading. If it stays that way, run the
  setup line again.
