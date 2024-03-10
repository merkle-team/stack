# `stack`

Tool for deploying services on EC2 instances in our infrastructure.

## Configuration

Create a `deploy.yml` file in your repository.

```yaml
# Name of the project/stack.
# Stacks represent a collection of infrastructure + pods deployed together to provide a "service".
stack: backend

# If the stack exposes services that receive inbound traffic, declare the load balancers here
load-balancers:
  rpc:
    type: application
    public: true
  websocket:
    type: network
    public: true

# Each pod is a collection of Docker containers running on a single EC2 instance
pods:
  api:
    image: ami-0a330430a1504ef77 # 64-bit ARM Amazon Linux 2023 with Docker Compose already installed
    instance: t4g.medium # 2 vCPUs, 4GB RAM, ARM

    # Give this much time after an instance first starts up before starting to perform health checks
    health-grace-period: 60

    # Path to Docker Compose configuration that defines containers, volumes, networks, etc.
    compose: ./relative/path/to/api/docker-compose.yml

    # Endpoints exposed by the pod
    endpoints:
      rpc:
        load-balancer: rpc # Reference to load balancer above
        protocol: HTTPS
        port: 443
        cert: "*.warpcast.com"
        idle-timeout: 25 # http/https protocol only. Terminate connection if no data sent in this many seconds
        deregistration:
          delay: 30 # How long to wait
          action: do-nothing # Or force-terminate-connection
        target:
          port: 8080
          protocol: HTTP # Protocol used to communicate with target (HTTP1)
          healthcheck:
            path: /healthcheck
            success-codes: 200 # Can be comma separated or range, e.g. "200,202" or "200-204"
            healthy-threshold: 2
            unhealthy-threshold: 2
            timeout: 2
            interval: 10 # Must be >= timeout

      websocket:
        load-balancer: websocket # Reference to load balancer above
        protocol: TLS
        port: 443
        cert: "*.warpcast.com"
        deregistration:
          delay: 0
          action: force-terminate-connection
        target:
          port: 8080
          protocol: TCP # Protocol used to communicate with target
          health:
            path: /healthcheck
            success-codes: 200 # Can be comma separated or range, e.g. "200,202" or "200-204"
            healthy-threshold: 2
            unhealthy-threshold: 2
            timeout: 2
            interval: 10 # Must be >= timeout

  worker:
    image: ami-0f93c02efd1974b8b
    instance: t4g.medium
    health-grace-period: 60
    compose: ./relative/path/to/worker/docker-compose.yml

  stream-worker:
    image: ami-0f93c02efd1974b8b
    instance: t4g.medium
    health-grace-period: 60
    compose: ./relative/path/to/stream-worker/docker-compose.yml

  temporal-worker:
    image: ami-0f93c02efd1974b8b
    instance: t4g.medium
    health-grace-period: 60
    compose: ./relative/path/to/temporal-worker/docker-compose.yml

  singleton:
    image: ami-0f93c02efd1974b8b
    instance: t4g.medium
    health-grace-period: 60
    compose: ./relative/path/to/singleton/docker-compose.yml

network:
  id: vpc-0f6f9a87c6da89cc3 # VPC ID to deploy the service within

  subnets:
    # Default subnets each public-facing load balancer can be deployed to
    public:
      - subnet-0c692bcb8e0b04af0 # public-1b
      - subnet-07ac4939a1d7db9c1 # public-1d
      - subnet-0305c0d827e803272 # public-1f

    # Default subnets each pod instance can be deployed to
    private:
      - subnet-09d8bb56d08618935 # private-1b
      - subnet-0fdd713886476d21c # private-1d
      - subnet-0d4f99e3a3569ec11 # private-1f
```
