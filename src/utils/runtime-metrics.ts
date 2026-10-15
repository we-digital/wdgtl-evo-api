import { monitorEventLoopDelay } from 'node:perf_hooks';
import { getHeapStatistics } from 'node:v8';

export const metricsPeerAllowed = (address: string | undefined, allowlist: string) => {
  const normalized = (address || '').replace(/^::ffff:/, '');
  return allowlist.split(',').some((item) => item.trim().replace(/^::ffff:/, '') === normalized && normalized !== '');
};

export const createRuntimeMetrics = () => {
  const eventLoop = monitorEventLoopDelay({ resolution: 20 });
  eventLoop.enable();
  return () => {
    const memory = process.memoryUsage();
    const cpu = process.cpuUsage();
    const gauges = {
      rss_bytes: memory.rss,
      heap_used_bytes: memory.heapUsed,
      heap_total_bytes: memory.heapTotal,
      heap_limit_bytes: getHeapStatistics().heap_size_limit,
      external_bytes: memory.external,
      array_buffers_bytes: memory.arrayBuffers,
      uptime_seconds: process.uptime(),
      cpu_user_seconds: cpu.user / 1e6,
      cpu_system_seconds: cpu.system / 1e6,
      event_loop_delay_p99_seconds: eventLoop.count ? eventLoop.percentile(99) / 1e9 : 0,
      event_loop_delay_max_seconds: eventLoop.count ? eventLoop.max / 1e9 : 0,
    };
    eventLoop.reset();
    return Object.entries(gauges).flatMap(([name, value]) => [
      `# TYPE evolution_process_${name} ${name.startsWith('cpu_') ? 'counter' : 'gauge'}`,
      `evolution_process_${name} ${value}`,
    ]);
  };
};
