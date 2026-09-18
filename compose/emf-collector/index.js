import { PassThrough } from 'node:stream'
import Docker from 'dockerode'
import {
  CloudWatchClient,
  PutMetricDataCommand
} from '@aws-sdk/client-cloudwatch'

const TARGET_SERVICES = (process.env.EMF_TARGET_SERVICES ?? '')
  .split(',')
  .map((name) => name.trim())
  .filter(Boolean)

const cloudwatch = new CloudWatchClient({
  endpoint: process.env.AWS_ENDPOINT_URL,
  region: process.env.AWS_REGION
})

const docker = new Docker({ socketPath: '/var/run/docker.sock' })

function parseEmfLine(line) {
  let payload
  try {
    payload = JSON.parse(line)
  } catch {
    return null
  }

  const metricDirectives = payload?._aws?.CloudWatchMetrics
  if (!Array.isArray(metricDirectives)) {
    return null
  }

  return metricDirectives.flatMap((directive) =>
    directive.Metrics.map((metric) => ({
      Namespace: directive.Namespace,
      MetricName: metric.Name,
      Unit: metric.Unit ?? 'None',
      Value: Number(payload[metric.Name]),
      Timestamp: new Date(payload._aws.Timestamp),
      Dimensions: (directive.Dimensions ?? []).flatMap((dimensionSet) =>
        dimensionSet.map((name) => ({
          Name: name,
          Value: String(payload[name])
        }))
      )
    }))
  )
}

async function publish(metricData) {
  const byNamespace = Map.groupBy(metricData, (entry) => entry.Namespace)

  await Promise.all(
    Array.from(byNamespace, ([Namespace, MetricData]) =>
      cloudwatch.send(
        new PutMetricDataCommand({
          Namespace,
          MetricData: MetricData.map(({ Namespace: _drop, ...rest }) => rest)
        })
      )
    )
  )
}

function attachToLogs(containerId, label) {
  const container = docker.getContainer(containerId)

  container.attach(
    { stream: true, stdout: true, stderr: false, logs: false },
    (err, stream) => {
      if (err) {
        console.error(
          `[emf-collector] failed to attach to ${label}: ${err.message}`
        )
        return
      }

      let buffer = ''
      const processText = (chunk) => {
        buffer += chunk.toString('utf8')
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          const metricData = line.trim() ? parseEmfLine(line) : null
          if (!metricData?.length) {
            continue
          }

          publish(metricData).catch((publishError) => {
            console.error(
              `[emf-collector] PutMetricData failed for ${label}: ${publishError.message}`
            )
          })
        }
      }

      const stdout = new PassThrough()
      stdout.on('data', processText)
      docker.modem.demuxStream(stream, stdout, null)

      stream.on('end', () => {
        console.error(`[emf-collector] stream ended for ${label}`)
      })

      console.error(`[emf-collector] attached to ${label}`)
    }
  )
}

const attachedContainerIds = new Set()

async function discoverAndAttachForService(serviceName) {
  const containers = await docker.listContainers({
    filters: JSON.stringify({
      label: [`com.docker.compose.service=${serviceName}`],
      status: ['running']
    })
  })

  for (const containerInfo of containers) {
    if (attachedContainerIds.has(containerInfo.Id)) {
      continue
    }

    attachedContainerIds.add(containerInfo.Id)
    attachToLogs(containerInfo.Id, serviceName)
  }
}

let discoveryInFlight = false

async function discoverAndAttach() {
  if (discoveryInFlight) {
    return
  }
  discoveryInFlight = true

  try {
    for (const serviceName of TARGET_SERVICES) {
      await discoverAndAttachForService(serviceName)
    }
  } finally {
    discoveryInFlight = false
  }
}

if (TARGET_SERVICES.length === 0) {
  console.error('[emf-collector] EMF_TARGET_SERVICES is empty, nothing to do')
  process.exit(1)
}

await discoverAndAttach()
setInterval(discoverAndAttach, 10_000)
