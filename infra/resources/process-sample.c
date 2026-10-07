/* Read-only macOS process accounting. No command names, argv, or environment. */
#include <inttypes.h>
#include <libproc.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/proc_info.h>
#include <sys/resource.h>
#include <time.h>

#define MAX_PIDS 16384
int main(int argc, char **argv) {
  (void)argv;
  if (argc != 1) return 2;
  int *pids = calloc(MAX_PIDS, sizeof(int));
  if (!pids) return 3;
  int count = proc_listallpids(pids, MAX_PIDS * (int)sizeof(int));
  /* A full buffer is indistinguishable from truncation: fail closed. */
  if (count <= 0 || count >= MAX_PIDS) { free(pids); return 4; }
  printf("cyberdeck-process-v1\n");
  unsigned emitted = 0, inaccessible = 0;
  for (int i = 0; i < count; i++) {
    if (pids[i] <= 0) continue;
    struct proc_bsdinfo before = {0}, after = {0};
    if (proc_pidinfo(pids[i], PROC_PIDTBSDINFO, 0, &before, sizeof(before)) != sizeof(before)) {
      inaccessible++; continue;
    }
    struct rusage_info_v2 usage = {0};
    int available = proc_pid_rusage(pids[i], RUSAGE_INFO_V2, (rusage_info_t *)&usage) == 0;
    struct timespec sampled = {0};
    if (clock_gettime(CLOCK_MONOTONIC, &sampled) != 0) { free(pids); return 5; }
    if (proc_pidinfo(pids[i], PROC_PIDTBSDINFO, 0, &after, sizeof(after)) != sizeof(after)
        || before.pbi_start_tvsec != after.pbi_start_tvsec
        || before.pbi_start_tvusec != after.pbi_start_tvusec) {
      inaccessible++; continue;
    }
    uint64_t monotonic = (uint64_t)sampled.tv_sec * UINT64_C(1000000000) + sampled.tv_nsec;
    printf("%d\t%u\t%" PRIu64 "\t%" PRIu64 "\t%" PRIu64 "\t", pids[i], after.pbi_ppid,
      after.pbi_start_tvsec, after.pbi_start_tvusec, monotonic);
    if (available) printf("%" PRIu64 "\t%" PRIu64 "\t%" PRIu64 "\t%" PRIu64 "\n",
      usage.ri_phys_footprint, usage.ri_resident_size, usage.ri_user_time, usage.ri_system_time);
    else printf("-\t-\t-\t-\n");
    emitted++;
  }
  free(pids);
  printf("end\t%u\t%u\n", emitted, inaccessible);
  return ferror(stdout) ? 6 : 0;
}
