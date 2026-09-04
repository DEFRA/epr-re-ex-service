import { describe, expect, it } from 'vitest'

import { parseEmf, toMetrics, toPutMetricDataForm } from './emf.mjs'

const emfDocument = {
  _aws: {
    Timestamp: Date.parse('2026-09-02T08:00:00.000Z'),
    CloudWatchMetrics: [
      {
        Namespace: 'epr-frontend',
        Dimensions: [['journey']],
        Metrics: [{ Name: 'TransactionStart', Unit: 'Count' }]
      }
    ]
  },
  journey: 'UploadSummaryLogStart',
  TransactionStart: 1
}

describe('#emf', () => {
  describe('toMetrics', () => {
    it('should read the value from the sibling key named by the metric', () => {
      const [metric] = toMetrics(emfDocument)

      expect(metric).toStrictEqual({
        namespace: 'epr-frontend',
        name: 'TransactionStart',
        unit: 'Count',
        value: 1,
        timestamp: '2026-09-02T08:00:00.000Z',
        dimensions: [{ name: 'journey', value: 'UploadSummaryLogStart' }]
      })
    })

    it('should resolve every dimension name against the flat document', () => {
      const [metric] = toMetrics({
        ...emfDocument,
        _aws: {
          ...emfDocument._aws,
          CloudWatchMetrics: [
            {
              ...emfDocument._aws.CloudWatchMetrics[0],
              Dimensions: [['journey', 'ServiceName']]
            }
          ]
        },
        ServiceName: 'epr-frontend'
      })

      expect(metric.dimensions).toStrictEqual([
        { name: 'journey', value: 'UploadSummaryLogStart' },
        { name: 'ServiceName', value: 'epr-frontend' }
      ])
    })

    it('should default a missing unit rather than omitting it', () => {
      const [metric] = toMetrics({
        ...emfDocument,
        _aws: {
          ...emfDocument._aws,
          CloudWatchMetrics: [
            {
              ...emfDocument._aws.CloudWatchMetrics[0],
              Metrics: [{ Name: 'TransactionStart' }]
            }
          ]
        }
      })

      expect(metric.unit).toBe('None')
    })

    it('should return one entry per metric in a directive', () => {
      const metrics = toMetrics({
        ...emfDocument,
        _aws: {
          ...emfDocument._aws,
          CloudWatchMetrics: [
            {
              ...emfDocument._aws.CloudWatchMetrics[0],
              Metrics: [
                { Name: 'TransactionStart' },
                { Name: 'TransactionEnd' }
              ]
            }
          ]
        },
        TransactionEnd: 1
      })

      expect(metrics.map(({ name }) => name)).toStrictEqual([
        'TransactionStart',
        'TransactionEnd'
      ])
    })

    it('should return nothing for a document carrying no metric directives', () => {
      expect(toMetrics({ message: 'hello' })).toStrictEqual([])
    })
  })

  describe('parseEmf', () => {
    it('should parse a document sent on its own line', () => {
      const metrics = parseEmf(JSON.stringify(emfDocument))

      expect(metrics.map(({ name }) => name)).toStrictEqual([
        'TransactionStart'
      ])
    })

    it('should ignore a line carrying no embedded metrics', () => {
      expect(
        parseEmf(JSON.stringify({ level: 30, msg: 'request' }))
      ).toStrictEqual([])
    })

    it('should ignore a malformed line rather than throwing', () => {
      expect(parseEmf('{"_aws": {"Timestamp"')).toStrictEqual([])
    })

    it('should ignore a blank line', () => {
      expect(parseEmf('')).toStrictEqual([])
    })
  })

  describe('toPutMetricDataForm', () => {
    it('should number metric members from one', () => {
      const form = toPutMetricDataForm('epr-frontend', toMetrics(emfDocument))

      expect(Object.fromEntries(form)).toStrictEqual({
        Action: 'PutMetricData',
        Version: '2010-08-01',
        Namespace: 'epr-frontend',
        'MetricData.member.1.MetricName': 'TransactionStart',
        'MetricData.member.1.Value': '1',
        'MetricData.member.1.Unit': 'Count',
        'MetricData.member.1.Timestamp': '2026-09-02T08:00:00.000Z',
        'MetricData.member.1.Dimensions.member.1.Name': 'journey',
        'MetricData.member.1.Dimensions.member.1.Value': 'UploadSummaryLogStart'
      })
    })

    it('should number each metric and dimension member independently', () => {
      const form = toPutMetricDataForm('epr-frontend', [
        {
          namespace: 'epr-frontend',
          name: 'TransactionStart',
          unit: 'Count',
          value: 1,
          timestamp: '2026-09-02T08:00:00.000Z',
          dimensions: [
            { name: 'journey', value: 'A' },
            { name: 'ServiceName', value: 'epr-frontend' }
          ]
        },
        {
          namespace: 'epr-frontend',
          name: 'TransactionEnd',
          unit: 'Count',
          value: 1,
          timestamp: '2026-09-02T08:00:00.000Z',
          dimensions: [{ name: 'journey', value: 'B' }]
        }
      ])

      expect(form.get('MetricData.member.1.Dimensions.member.2.Name')).toBe(
        'ServiceName'
      )
      expect(form.get('MetricData.member.2.MetricName')).toBe('TransactionEnd')
      expect(form.get('MetricData.member.2.Dimensions.member.1.Value')).toBe(
        'B'
      )
    })
  })
})
