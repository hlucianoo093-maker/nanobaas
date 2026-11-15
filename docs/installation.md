# Local installation

This guide runs NanoBaaS and its admin dashboard locally from the project source. It is not a native desktop installer.

## Requirements

- Node.js supported by this project: `>=22 <27` (use an even-numbered LTS release)
- npm, included with Node.js
- Git, if you are cloning the repository
- Internet access to install the npm dependencies

Open a terminal in the NanoBaaS source directory, the one containing `package.json`. Native dependencies such as SQLite and Argon2 may need platform build tools if a prebuilt package is unavailable.
Obtain the source by cloning your authorized repository or extracting a NanoBaaS source archive. Install Git for your operating system if you plan to clone it.

## WSL2 with Ubuntu

From PowerShell running as Administrator, install or update WSL2:

```powershell
wsl --install -d Ubuntu
wsl --update
```

Restart Windows if prompted, then open the Ubuntu application. Run NanoBaaS inside the Linux distribution; do not install its Node dependencies from Windows. Keep the source and database in the WSL Linux filesystem (for example, `~/projects/nanobaas`), not under `/mnt/c`, for better SQLite and native-module performance.

In Ubuntu, install the build prerequisites:

```bash
sudo apt update
sudo apt install -y git build-essential python3
```

Install `nvm` using its [official installation instructions](https://github.com/nvm-sh/nvm#installing-and-updating), then install a supported Node.js release:

```bash
nvm install 22
nvm use 22
node --version
npm --version
```

Continue with [Configure and start NanoBaaS](#configure-and-start-nanobaas). Windows can usually reach a service running in WSL2 at `http://localhost:3000`.

## Windows

Install a supported Node.js LTS release from the [official Node.js download page](https://nodejs.org/en/download), then open a new PowerShell terminal. Verify that `node --version` reports a version in the supported range (`>=22 <27`).

If `npm.cmd ci` fails while compiling a native dependency, install the Visual Studio Build Tools with **Desktop development with C++**, then retry.

Continue with [Configure and start NanoBaaS](#configure-and-start-nanobaas). PowerShell examples use `npm.cmd` to avoid execution-policy issues with the `npm.ps1` shim.

## macOS

Install the Xcode command-line tools:

```bash
xcode-select --install
```

Install a supported Node.js LTS release from the [official Node.js download page](https://nodejs.org/en/download), open a new Terminal, and verify `node --version` is in the supported range (`>=22 <27`).

Continue with [Configure and start NanoBaaS](#configure-and-start-nanobaas).

## Configure and start NanoBaaS

Copy the example environment file and edit it:

**PowerShell**

```powershell
Copy-Item .env.example .env
notepad .env
```

**WSL2 / macOS**

```bash
cp .env.example .env
chmod 600 .env
nano .env
```

Set at least these values in `.env`:

```dotenv
NODE_ENV=production
HOST=127.0.0.1
PORT=3000
JWT_SECRET=replace-with-a-random-secret-at-least-32-characters
```

Replace the example `JWT_SECRET` with a unique random value. Generate one with Node.js:

```text
node --input-type=module -e 'import { randomBytes } from "node:crypto"; console.log(randomBytes(48).toString("base64url"))'
```

Copy the output into `.env`; do not commit or share the file. `HOST=127.0.0.1` keeps the service available only to the local computer. Do not change it to `0.0.0.0` unless you understand and intend to expose the API to other machines.

Install dependencies, build the API and dashboard, apply database migrations, and start the service:

**PowerShell**

```powershell
npm.cmd ci
npm.cmd run build
npm.cmd run db:migrate
npm.cmd start
```

**WSL2 / macOS**

```bash
npm ci
npm run build
npm run db:migrate
npm start
```

Keep the terminal open while NanoBaaS is running. Then open:

- Admin dashboard: <http://localhost:3000/admin/>
- API documentation: <http://localhost:3000/documentation>
- Health check: <http://localhost:3000/health>

The dashboard's **Projects** section contains the guided project setup wizard. Stop the service with `Ctrl+C`.

## Optional services

- Set `WEBHOOK_ENCRYPTION_KEY` to a new 32-byte key encoded as 64 hexadecimal characters to enable webhook management and delivery. Generate one with:

  ```text
  node --input-type=module -e 'import { randomBytes } from "node:crypto"; console.log(randomBytes(32).toString("hex"))'
  ```

  Keep this key stable and private. Losing it prevents decryption of existing webhook secrets.
- Configure `SMTP_HOST` and `SMTP_FROM` (and `SMTP_USER` plus `SMTP_PASSWORD` when required) to enable email verification and password-reset delivery. Platform administrators must verify their email addresses.
- Database and uploaded-file data use `DATABASE_PATH` and `STORAGE_PATH` from `.env`; the defaults are under `./data`. Back up this directory and the webhook key together.

## Native application installers

The commands above are source-based local setup. Signed Windows installers, Linux packages, and macOS application packages are not yet available. Those will be separate release deliverables; the dashboard wizard is already included in the built NanoBaaS dashboard and does not need a separate installation.
