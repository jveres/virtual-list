// macOS process footprint includes compressed and graphics allocations that RSS
// and the JavaScript heap miss. Read only PIDs owned by the capture runner.
#include <errno.h>
#include <dlfcn.h>
#include <libproc.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int parse_pid(const char *value) {
  char *end;
  long pid = strtol(value, &end, 10);
  if (end == value || *end || pid <= 0 || pid > 2147483647) exit(2);
  return (int)pid;
}

int main(int argc, char **argv) {
  if (argc >= 3 && strcmp(argv[1], "--owned") == 0) {
    const int owner = parse_pid(argv[2]);
    // XPC services have launchd as parent. Resolve the responsible application
    // instead; never count another app's newly launched WebKit services.
    // Private macOS API, also used by Chromium's process_info_mac.mm.
    pid_t (*responsible)(pid_t) =
        dlsym(RTLD_DEFAULT, "responsibility_get_pid_responsible_for_pid");
    if (!responsible) {
      fputs("Process ownership API unavailable\n", stderr);
      return 1;
    }
    for (int i = 3; i < argc; i++) {
      const int pid = parse_pid(argv[i]);
      const pid_t application = responsible(pid);
      if (application <= 0) {
        if (kill(pid, 0) == -1 && errno == ESRCH) continue;
        fprintf(stderr, "Cannot resolve responsible application for PID %d\n", pid);
        return 1;
      }
      if (application == owner) printf("%d\n", pid);
    }
    return 0;
  }
  for (int i = 1; i < argc; i++) {
    const int pid = parse_pid(argv[i]);
    struct rusage_info_v4 usage = {0};
    if (proc_pid_rusage((int)pid, RUSAGE_INFO_V4, (rusage_info_t *)&usage)) {
      if (errno == ESRCH) continue;
      perror("proc_pid_rusage");
      return 1;
    }
    printf("%d %llu %llu %llu\n", pid, usage.ri_phys_footprint,
           usage.ri_resident_size, usage.ri_lifetime_max_phys_footprint);
  }
  return 0;
}
