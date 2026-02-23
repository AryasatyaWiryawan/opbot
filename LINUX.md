# Deploying to Linux (Ubuntu 24.04 LTS)

This guide provides step-by-step instructions on how to deploy and run your Minecraft Bedrock bot on your Ubuntu VPS.

## 1. Connect to your VPS
First, make sure you are logged into your Ubuntu Linux server (VPS) as `root` (or a user with `sudo` privileges), which you can see in your screenshot.

## 2. Update the System
It's always good practice to update your package lists and install any pending updates.
```bash
sudo apt update && sudo apt upgrade -y
```

## 3. Install Required Dependencies
Since your bot relies on Node.js and C++ addons (like `raknet-native`), you need to install Node.js (version 20+ is recommended) and the build tools required to compile native C++ packages.

```bash
# Install curl
sudo apt install -y curl

# Add Node.js v20 repository and install Node.js
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Install build tools (C++ compiler, make, python) required for `raknet-native`
sudo apt install -y build-essential python3 git
```
Verify the installation was successful:
```bash
node -v
npm -v
```

## 4. Transfer Your Project to the VPS
You need to move your `bedrock-protocol` project files onto the Linux server. 
You can do this by using a GitHub repository (recommended) or using an SFTP client (like FileZilla, WinSCP) or standard `scp`.

### Option A: Using Git (Recommended)
If your project is on GitHub:
```bash
git clone https://github.com/your-username/bedrock-protocol.git
cd bedrock-protocol
```
*Note: If your repo is private, you will need to authenticate.*

### Option B: Using SFTP / WinSCP
1. Download [WinSCP](https://winscp.net/eng/index.php).
2. Connect to your VPS IP using your root username and password.
3. Drag and drop your `bedrock-protocol` folder from Windows directly into the `/root/` folder on the Linux machine.
4. Go back to your Linux terminal and type:
```bash
cd /root/bedrock-protocol
```

> **Important**: Do not transfer the `node_modules` folder, `auth_cache`, or `.env` files if downloading from a public Git repo. If you use SFTP, you can skip copying `node_modules`. Instead, install them fresh on the VPS.

## 5. Install NPM Packages
Once you are inside the `bedrock-protocol` folder on your VPS, install the required packages.
*(Because we installed `build-essential` earlier, `raknet-native` should build successfully without the errors you might have had on Windows RDP).*

```bash
npm install
```

Make sure to create/configure your `.env` file or `auth_cache` if needed!
```bash
# Example if you need to create an .env file
nano .env 
# Add your environment variables, then save (Ctrl+O, Enter, Ctrl+X)
```

## 6. Run the Bot
To test if it works, you can start the bot exactly as you do on Windows:
```bash
npm run bot
```

## 7. Keep the Bot Running in the Background (Highly Recommended)
If you close the SSH / terminal window, `npm run bot` will stop automatically. To prevent this, use a process manager like `pm2`.

**Install PM2 globally:**
```bash
sudo npm install -g pm2
```

**Start your bot using PM2:**
```bash
# Start the bot from package.json's script
pm2 start npm --name "bedrock-bot" -- run bot
```

**Useful PM2 Commands:**
- `pm2 status`: view running bots
- `pm2 logs bedrock-bot`: view bot terminal output/console.logs
- `pm2 stop bedrock-bot`: stop the bot
- `pm2 restart bedrock-bot`: restart the bot
- `pm2 startup`: make the bot automatically start if the VPS restarts

## 8. Managing Multiple Terminals (Screen / Tmux)
When connected via SSH to a Linux VPS, you might want to run multiple tasks simultaneously in different terminal windows, view logs side-by-side, or keep an active terminal session running even when you disconnect. You can achieve this using a terminal multiplexer like `tmux` or `screen`.

### Using Tmux (Recommended)
`tmux` is a modern and powerful tool that allows you to create multiple terminal sessions inside a single SSH connection and split your screen.

**Install tmux:**
```bash
sudo apt install tmux -y
```

**Basic tmux Commands:**
- `tmux` - Start a new, unnamed tmux session.
- `tmux new -s setup` - Start a new session explicitly named "setup".
- **Detach** (leave running in background): Press `Ctrl+B`, release, then press `D`.
- **Reattach**: Run `tmux attach` to reconnect to the last session, or `tmux attach -t setup` to target a specific one.
- **List active sessions**: `tmux ls`
- **Split screen vertically** (left/right): Press `Ctrl+B`, release, then `%`
- **Split screen horizontally** (top/bottom): Press `Ctrl+B`, release, then `"`
- **Switch between splits**: Press `Ctrl+B`, release, then use the arrow keys to move around.

### Using Screen
`screen` is an older, widely used alternative to `tmux`. It's a bit simpler if you just want to run tasks in the background without fancy window splitting.

**Install screen:**
```bash
sudo apt install screen -y
```

**Basic screen Commands:**
- `screen` - Start a new session.
- `screen -S mybot` - Start a named session.
- **Detach** (keep running): Press `Ctrl+A`, release, then `D`.
- **Reattach**: Run `screen -r` (or `screen -r mybot`).
- **List active sessions**: `screen -ls`

## 9. Uploading Your Code to GitHub
Uploading your project to GitHub makes it much easier to transfer code to your VPS (as shown in Step 4, Option A).

### On your local Windows machine:
1. **Create a `.gitignore` file** in your project folder (if you don't have one) to prevent uploading huge or sensitive folders:
```text
node_modules/
.env
auth_cache/
```

2. **Initialize Git** in your project folder (if not done already):
```bash
git init
```

3. **Add all your files and commit them**:
```bash
git add .
git commit -m "Initial commit for bedrock bot"
```

4. **Create a new repository on GitHub.** (Go to GitHub.com, log in, click the '+' icon in the top right, and select "New repository"). Do not initialize it with a README, `.gitignore`, or license just yet.

5. **Link your local project to GitHub**. GitHub will give you the exact commands to push an existing repository. They will look something like this:
```bash
git branch -M main
git remote add origin https://github.com/your-username/your-repo-name.git
git push -u origin main
```

Now your code is safely on GitHub, and you can simply run `git clone https://github.com/your-username/your-repo-name.git` on your Linux VPS to download it! If you make changes on Windows, just commit and push them, then run `git pull` on your VPS to update it.
