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

### GitHub Integration

Each push to `main`:

1. Builds a new Docker image
2. Pushes it to ECR
3. Deploys the green (staging) environment
4. Waits for manual promotion (outside the stack) to update blue

## Notes

* The green environment is rebuilt automatically and serves as a live preview for the latest code.
* The blue environment remains unchanged unless manually redeployed with a new `imageTag`.
* Both environments share identical compute and container configuration to ensure parity.

## Cleanup

```bash
cdk destroy
```