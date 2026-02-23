# Project Setup Guide

This guide details the requirements and steps to set up and run the Minecraft Bedrock Protocol bot on Windows and Linux.

## Prerequisites

- **Node.js**: Version 18.x or 20.x (LTS) is recommended.
  - Check version: `node -v`
- **Git**: For cloning the repository.
- **npm**: Comes with Node.js.

## System Requirements

This project uses `raknet-native`, a C++ addon that requires native compilation tools if prebuilt binaries are not available for your system.

### 🪟 Windows Setup

1. **Install Node.js**
   - Download and install from [nodejs.org](https://nodejs.org/).

2. **Install Build Tools**
   You need Compilers (C++) and Python for compiling native modules.
   
   **Option A: Admin PowerShell (Recommended)**
   Run this command in PowerShell as Administrator:
   ```powershell
   npm install --global --production windows-build-tools
   ```
   *Note: This might hang or take a long time. If it fails, try Option B.*

   **Option B: Manual Installation**
   1. Install [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/).
   2. During installation, select the **"Desktop development with C++"** workload.
   3. Ensure **CMake** tools are selected in the optional components on the right side.
   4. Install [Python 3](https://www.python.org/downloads/) and add it to your PATH.

3. **Install CMake** (If not included in VS Build Tools)
   - Download from [cmake.org](https://cmake.org/download/) and add to PATH.

### 🐧 Linux (Ubuntu/Debian) Setup

1. **Install Node.js**
   ```bash
   curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
   sudo apt-get install -y nodejs
   ```

2. **Install Build Essentials**
   Required for compiling C++ addons.
   ```bash
   sudo apt-get update
   sudo apt-get install -y build-essential cmake python3 python3-pip
   ```

## Installation

1. **Clone the repository**
   ```bash
   git clone <your-repo-url>
   cd bedrock-protocol
   ```

2. **Install Dependencies**
   ```bash
   npm install
   ```
   *If this fails on `raknet-native`, ensure your C++ build tools (Visual Studio or build-essential) are correctly installed.*

## Configuration

1. Create a `.env` file in the root directory (copy from default if available, or create new).
2. Add necessary environment variables:
   ```env
   SERVER_HOST=donutsmp.net
   SERVER_PORT=19132
   # Add other config as needed
   ```

## Running the Project

- **Run the Bot**:
  ```bash
  npm run bot
  ```

- **Run the Debug Relay**:
  First, edit `debug_relay.js` to set the destination host if needed.
  ```bash
  node debug_relay.js
  ```
