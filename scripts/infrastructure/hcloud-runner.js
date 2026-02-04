const https = require('https');

const HCLOUD_TOKEN = process.env.HCLOUD_TOKEN;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN; // GitHub PAT to create registration tokens
const REPO = process.env.GITHUB_REPOSITORY; // e.g. "chikosan/vkanban"

if (!HCLOUD_TOKEN || !GITHUB_TOKEN || !REPO) {
  console.error("Missing required environment variables.");
  process.exit(1);
}

const API_BASE = "https://api.hetzner.cloud/v1";

async function request(path, options = {}) {
  const url = `${API_BASE}${path}`;
  const defaultOptions = {
    headers: {
      "Authorization": `Bearer ${HCLOUD_TOKEN}`,
      "Content-Type": "application/json"
    }
  };
  
  return new Promise((resolve, reject) => {
    const req = https.request(url, { ...defaultOptions, ...options }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(data ? JSON.parse(data) : {});
        } else {
          reject(new Error(`API Error: ${res.statusCode} ${data}`));
        }
      });
    });
    req.on('error', reject);
    if (options.body) req.write(JSON.stringify(options.body));
    req.end();
  });
}

// Get GitHub Runner Registration Token via API
async function getRegistrationToken() {
  const url = `https://api.github.com/repos/${REPO}/actions/runners/registration-token`;
  console.log(`Fetching registration token for ${REPO}...`);
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: 'POST',
      headers: {
        'Authorization': `token ${GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'node.js'
      }
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 201) {
          resolve(JSON.parse(data).token);
        } else {
          console.error(`GitHub API response: ${data}`);
          reject(new Error(`GitHub Token Error: ${res.statusCode} (Ensure GH_PAT has 'repo' scope and is not expired)`));
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function createServer(name, serverType = "cx53") {
  const githubToken = await getRegistrationToken();
  const arch = serverType.startsWith("cax") ? "arm64" : "x64";
  const runnerUrl = arch === "arm64" 
    ? "https://github.com/actions/runner/releases/download/v2.321.0/actions-runner-linux-arm64-2.321.0.tar.gz"
    : "https://github.com/actions/runner/releases/download/v2.321.0/actions-runner-linux-x64-2.321.0.tar.gz";

  const userData = `#!/bin/bash
# Install Docker
apt-get update
apt-get install -y docker.io curl tar
systemctl start docker
systemctl enable docker

# Install GitHub Runner
mkdir /actions-runner && cd /actions-runner
curl -o runner.tar.gz -L ${runnerUrl}
tar xzf runner.tar.gz
export RUNNER_ALLOW_RUNASROOT=1
./config.sh --url https://github.com/${REPO} --token ${githubToken} --name ${name} --labels self-hosted,${arch},hetzner --unattended
./svc.sh install
./svc.sh start
`;

  console.log(`Creating server ${name} (${serverType}, ${arch})...`);
  const response = await request("/servers", {
    method: "POST",
    body: {
      name,
      server_type: serverType,
      image: "ubuntu-24.04",
      location: "fsn1",
      user_data: userData,
      ssh_keys: ["github--build-key"],
      labels: { "github-runner": "true", "runner-name": name }
    }
  });
  console.log(`Server created. ID: ${response.server.id}`);
  return response.server;
}

async function deleteServerByName(name) {
  console.log(`Searching for server with name: ${name}`);
  const response = await request(`/servers?name=${name}`);
  if (response.servers && response.servers.length > 0) {
    const id = response.servers[0].id;
    console.log(`Deleting server ${name} (ID: ${id})...`);
    await request(`/servers/${id}`, { method: "DELETE" });
    console.log("Server deleted.");
  } else {
    console.log("Server not found.");
  }
}

const command = process.argv[2];
const serverName = process.argv[3];
const serverType = process.argv[4] || "cax21"; // cax21 is a decent ARM64 type

if (command === "create") {
  createServer(serverName, serverType).catch(err => {
    console.error(err);
    process.exit(1);
  });
} else if (command === "delete") {
  deleteServerByName(serverName).catch(err => {
    console.error(err);
    process.exit(1);
  });
} else {
  console.log("Usage: node hcloud-runner.js [create|delete] [name] [type]");
}
