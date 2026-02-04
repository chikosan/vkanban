const https = require('https');
const { execSync } = require('child_process');

const HCLOUD_TOKEN = process.env.HCLOUD_TOKEN;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const REPO = process.env.GITHUB_REPOSITORY;

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

async function getRegistrationToken() {
  console.log(`Fetching registration token for ${REPO}...`);
  try {
    const command = `gh api --method POST repos/${REPO}/actions/runners/registration-token -q .token`;
    const token = execSync(command).toString().trim();
    if (token) return token;
  } catch (e) {
    console.error(`gh CLI failed: ${e.stdout?.toString() || e.message}`);
  }

  try {
    console.log("Attempting curl fallback for registration token...");
    const command = `curl -v -X POST -fsSL -H "Authorization: token ${GITHUB_TOKEN}" -H "Accept: application/vnd.github.v3+json" https://api.github.com/repos/${REPO}/actions/runners/registration-token`;
    const response = execSync(command).toString();
    return JSON.parse(response).token;
  } catch (e) {
    console.error(`curl failed: ${e.stdout?.toString() || e.message}`);
    throw new Error(`GitHub Token Retrieval Error: ${e.message}`);
  }
}

async function createServer(name, serverType = "cx53") {
  let githubToken = "";
  try {
    githubToken = await getRegistrationToken();
  } catch (e) {
    console.error(`Warning: Could not get GitHub registration token: ${e.message}`);
  }

  const arch = serverType.startsWith("cax") ? "arm64" : "x64";
  const runnerUrl = arch === "arm64" 
    ? "https://github.com/actions/runner/releases/download/v2.321.0/actions-runner-linux-arm64-2.321.0.tar.gz"
    : "https://github.com/actions/runner/releases/download/v2.321.0/actions-runner-linux-x64-2.321.0.tar.gz";

  const userData = `#!/bin/bash
exec > >(tee /var/log/user-data.log|logger -t user-data -s 2>/dev/console) 2>&1
echo "Starting user-data script..."

# Install Docker
apt-get update
apt-get install -y docker.io curl tar
systemctl start docker
systemctl enable docker

# Install GitHub Runner
if [ ! -z "${githubToken}" ]; then
  echo "Registering GitHub Runner..."
  mkdir /actions-runner && cd /actions-runner
  curl -o runner.tar.gz -L ${runnerUrl}
  tar xzf runner.tar.gz
  export RUNNER_ALLOW_RUNASROOT=1
  sleep 5
  ./config.sh --url https://github.com/${REPO} --token ${githubToken} --name ${name} --labels self-hosted,${arch},hetzner --unattended
  ./svc.sh install
  ./svc.sh start
  echo "Runner registration complete."
else
  echo "No GitHub token provided, skipping runner registration."
fi
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
const serverType = process.argv[4];

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
}