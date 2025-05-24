# ECS Blue/Green Deployment Stack (CDK)

This AWS CDK stack defines a **Blue/Green deployment pipeline** for a containerized application hosted on Amazon ECS with Fargate and an Application Load Balancer (ALB). It provisions two fully independent environments:

- **Blue (Production)**: Stable environment that receives live traffic. It is updated only when explicitly triggered with a specified Docker image tag.
- **Green (Staging)**: Automatically rebuilt on every push to the GitHub repository. It is isolated behind a firewall rule and only accessible to a specified IP address for staging and QA purposes.

## Features

- 🚀 **GitHub-Integrated CI/CD**: Commits to the `main` branch trigger a pipeline that builds and deploys the green (staging) environment.
- 🔐 **Staging Access Control**: Green is restricted to a specific IP address via ALB listener conditions.
- 🟦 **Stable Production Releases**: Blue is updated manually using an explicit image tag, ensuring controlled releases.
- ♻️ **Isolated Environments**: Separate ECS services, target groups, and task definitions for blue and green environments.
- 📦 **Containerized Deployment**: Built with Docker, stored in ECR, and deployed via ECS Fargate.

## Deployment Prerequisites

- AWS CDK v2 installed
- GitHub access token stored in AWS Secrets Manager under the name `github-token`
- A GitHub repository containing a Dockerized application

## Usage

### Deploy the Stack

```bash
cdk deploy \
  --context imageTag=my-image-tag \
  --context allowedIp=YOUR.IP.ADDRESS.HERE
````

* `imageTag`: **Required**. Specifies the Docker image tag to use. Defaults to `nginx` if no suitable tag is provided.
* `allowedIp`: **Required**. Restricts access to the green environment.

---

### GitHub Integration & Deployment Workflow

1. **Initial Deployment**
   You deploy the stack using:

   ```bash
   cdk deploy \
     --context imageTag=nginx \
     --context allowedIp=YOUR.IP.ADDRESS.HERE
   ```

   Both `blue` and `green` environments will be initialized with the default `nginx` container, showing the standard Nginx welcome screen.

2. **Staging Updates Automatically**
   Every push to the `main` branch of your GitHub repo triggers a CI/CD pipeline that:

   * Builds a new Docker image
   * Pushes it to ECR
   * Deploys it to the **green** (staging) environment

   Only the IP address specified by `allowedIp` will be able to access this environment.

3. **Promoting to Production (Blue)**
   When you're satisfied with the green deployment, you manually promote it by running:

   ```bash
   cdk deploy \
     --context imageTag=<tag-used-by-green> \
     --context allowedIp=YOUR.IP.ADDRESS.HERE
   ```

   This updates the **blue** (production) environment with the same image used in green, making it publicly live.

---

### Notes

* Green is automatically rebuilt on every GitHub push. It reflects the latest commit on the `main` branch.
* Blue remains stable until manually updated with an `imageTag` via CDK.
* You manage the blue/green lifecycle explicitly through separate deployments and load balancer routing rules.
* Both environments use identical container, CPU, memory, and port settings for parity.

## Cleanup

```bash
cdk destroy
```