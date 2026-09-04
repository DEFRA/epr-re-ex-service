// Turning EMF documents into CloudWatch metric data points.
//
// aws-embedded-metrics never calls PutMetricData. It ships an EMF document to
// the CloudWatch agent, which forwards it to PutLogEvents, and the CloudWatch
// Logs *service* parses _aws.CloudWatchMetrics to materialise the metrics. The
// local AWS emulator implements the CloudWatch APIs but not that extraction, so
// something has to stand in for it. These are the pure parts of doing that.

/**
 * @typedef {{ name: string, value: string }} Dimension
 * @typedef {{
 *   namespace: string,
 *   name: string,
 *   unit: string,
 *   value: number,
 *   timestamp: string,
 *   dimensions: Dimension[]
 * }} Metric
 */

/**
 * A directive names its metrics and lists its dimensions by name only; both the
 * metric values and the dimension values live as sibling keys on the document
 * itself, so each name is looked up there.
 * @param {Record<string, any>} document
 * @returns {Metric[]}
 */
export const toMetrics = (document) =>
  (document._aws?.CloudWatchMetrics ?? []).flatMap((directive) =>
    directive.Metrics.map((metric) => ({
      namespace: directive.Namespace,
      name: metric.Name,
      unit: metric.Unit ?? 'None',
      value: Number(document[metric.Name]),
      timestamp: new Date(document._aws.Timestamp).toISOString(),
      dimensions: (directive.Dimensions?.[0] ?? []).map((name) => ({
        name,
        value: String(document[name])
      }))
    }))
  )

/**
 * @param {string} line
 * @returns {Metric[]}
 */
export const parseEmf = (line) => {
  try {
    return toMetrics(JSON.parse(line))
  } catch {
    return []
  }
}

/**
 * The query-string form of PutMetricData. Building it by hand keeps the pump
 * free of an AWS SDK dependency, which matters because it runs from a read-only
 * mount with no install step.
 * @param {string} namespace
 * @param {Metric[]} metrics
 * @returns {URLSearchParams}
 */
export const toPutMetricDataForm = (namespace, metrics) => {
  const form = new URLSearchParams({
    Action: 'PutMetricData',
    Version: '2010-08-01',
    Namespace: namespace
  })

  metrics.forEach((metric, index) => {
    const member = `MetricData.member.${index + 1}`

    form.set(`${member}.MetricName`, metric.name)
    form.set(`${member}.Value`, String(metric.value))
    form.set(`${member}.Unit`, metric.unit)
    form.set(`${member}.Timestamp`, metric.timestamp)

    metric.dimensions.forEach((dimension, position) => {
      const key = `${member}.Dimensions.member.${position + 1}`

      form.set(`${key}.Name`, dimension.name)
      form.set(`${key}.Value`, dimension.value)
    })
  })

  return form
}

/**
 * @param {Metric[]} metrics
 * @returns {Map<string, Metric[]>}
 */
export const groupByNamespace = (metrics) =>
  metrics.reduce(
    (grouped, metric) =>
      grouped.set(metric.namespace, [
        ...(grouped.get(metric.namespace) ?? []),
        metric
      ]),
    /** @type {Map<string, Metric[]>} */ (new Map())
  )
