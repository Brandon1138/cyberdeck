// Persistent-inode advisory lock. Kernel lifetime replaces unsafe stale-file deletion.
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <unistd.h>

int main(int argc, char **argv) {
  if (argc != 2 || argv[1][0] != '/') return 64;
  int fd = open(argv[1], O_CREAT | O_RDWR | O_NOFOLLOW | O_CLOEXEC, 0600);
  if (fd < 0) return 65;
  struct stat info;
  if (fstat(fd, &info) || !S_ISREG(info.st_mode) || info.st_uid != getuid() || info.st_size != 0) { close(fd); return 66; }
  if (flock(fd, LOCK_EX | LOCK_NB)) { close(fd); return 73; }
  if (fchmod(fd, 0600)) { close(fd); return 74; }
  if (puts("cyberdeck-resource-owner-v1") < 0 || fflush(stdout)) { close(fd); return 74; }
  char input[256];
  for (;;) {
    ssize_t count = read(STDIN_FILENO, input, sizeof(input));
    if (!count) break;
    if (count < 0 && errno != EINTR) { close(fd); return 74; }
  }
  close(fd);
  return 0;
}
