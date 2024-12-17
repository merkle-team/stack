# `stack`

Tool for deploying services on AWS EC2 instances.

## Installation

Stack is distributed as a Docker image.

### Requirements

- Docker
- **Architecture**: x86_64 (a.k.a. Intel) or arm64 (a.k.a. Apple Silicon)

To avoid having to install Terraform + the Terraform CDK, a Docker image is provided along with a helper script you can install to make running Stack easier.

### Download

Install a helper script in `/usr/local/bin/stack` which installs a shim so you can run Stack like a normal executable without having to provide all the `docker run` flags explicitly.

```
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/warpcast/stack/refs/heads/main/install.sh)"
```

Assuming `/usr/local/bin` is in your `PATH`, you can now run:

```
stack --help
```

...to download the image and confirm everything is working correctly.

### Upgrading

Just follow the [**Download**](#Download) instructions again to upgrade.

### Uninstall

Installation just installs a shim, which can be removed with:

```
sudo rm -f /usr/local/bin/stack
```

## Getting started

Create a `deploy.yml` file in your repository.

```yaml
# Name of the project/stack. Must be unique across all infrastructure in a VPC.
# Stacks represent a collection of infrastructure + pods deployed together to provide a "service".
stack: my-project

region: us-east-1

network:
  id: vpc-fffffffffffffffff
  subnets:
    public:
      - subnet-11111111111111111
      - subnet-22222222222222222
      - subnet-33333333333333333
    private:
      - subnet-aaaaaaaaaaaaaaaaa
      - subnet-bbbbbbbbbbbbbbbbb
      - subnet-ccccccccccccccccc

x-shared-pod-options: &shared-pod-options
  image: ami-00000000000000000 # Machine image to boot
  sshUser: ec2-user
  bastionUser: ec2-user
  bastionHost: 1.2.3.4 # IP Address of SSH bastion host
  compose: ./relative/path/to/deploy-docker-compose.yml
  initScript: ec2-first-boot.sh
  rolePolicies:
    - arn:aws:iam::01234567890a:policy/my-project/send-email-policy
  deploy:
    replaceWith: new-instances
    shutdownTimeout: 10
    instanceRefreshTimeout: 900

# Each pod is a collection of Docker containers running on a single EC2 instance
pods:
  api:
    <<: *shared-pod-options
    instance: t4g.medium
    environment:
      DOCKER_IMAGE: # Provided by deployment process after image is built
      TASK_TYPE: api
    loadBalancers:
      api:
        type: application
        public: true
        # Only for ALBs. Ensure this is smaller than the application server's keep-alive timeout.
        # See: https://adamcrowder.net/posts/node-express-api-and-aws-alb-502/
        idleTimeout: 25
    endpoints:
      api:
        loadBalancer:
          name: api # Refers to the LB name above
          protocol: HTTPS
          port: 443
          cert: my-cert-domain.com
        public: false # Only load balancer is public, not the EC2 instance
        target:
          port: 3000
          protocol: HTTP
          deregistration:
            delay: 30 # Must be longer than idleTimeout
          healthCheck:
            path: "/_health"
            healthyThreshold: 1
            unhealthyThreshold: 2
            timeout: 2
            interval: 5
    autoscaling:
      healthCheckGracePeriod: 60 # EC2 instances sometimes take a while to start
      minHealthyPercentage: 100
      maxHealthyPercentage: 200
      minHealthyInstances: 1
      onDemandBaseCapacity: 1
      onDemandPercentageAboveBaseCapacity: 50
  background-worker:
    <<: *shared-pod-options
    instance: t4g.large
    environment:
      DOCKER_IMAGE: # Provided by deployment process after image is built
      TASK_TYPE: background-worker
    autoscaling:
      healthCheckGracePeriod: 60 # EC2 instances sometimes take a while to start
      minHealthyPercentage: 100
      maxHealthyPercentage: 200
      minHealthyInstances: 1
      onDemandBaseCapacity: 1
      onDemandPercentageAboveBaseCapacity: 50

secrets:
  API_KEY:
  SHARED_TOKEN:
    as: TOKEN
  API_SECRET:
    as: SECRET
    pods: [api] # Only exposed to the `api` pod
```
