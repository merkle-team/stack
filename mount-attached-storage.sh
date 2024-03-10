# Runs via cloud-init as root user on first boot.

set -ex -o pipefail

DEVICE_NAME=/dev/nvme1n1
MOUNT_DIR=/var/lib/docker

# Initialize the mounted partition with XFS file system
mkfs -t xfs $DEVICE_NAME

# Add to fstab so that the mount is automounted on reboot
echo "$DEVICE_NAME $MOUNT_DIR xfs defaults,noatime 0 2" >> /etc/fstab

# Mount!
mkdir -p $MOUNT_DIR
mount $DEVICE_NAME $MOUNT_DIR
