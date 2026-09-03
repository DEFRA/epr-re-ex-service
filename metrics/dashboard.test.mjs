import { describe, expect, it } from 'vitest'

import {
  cloudwatchDatasourceUid,
  contentBottom,
  describeDrift,
  maxPanelId,
  mergeIntoTarget,
  targetStamp
} from './dashboard.mjs'

const datasource = { type: 'cloudwatch', uid: 'target-uid' }

const target = {
  id: 41,
  uid: 'epr-backend-epr-re-ex-service-bd579e7f',
  title: 'epr-backend (epr-re-ex-service)',
  schemaVersion: 41,
  panels: [
    {
      id: 4,
      type: 'row',
      title: 'PRN Statuses',
      gridPos: { x: 0, y: 0, w: 24, h: 1 }
    },
    {
      id: 9,
      type: 'stat',
      title: 'Status Transitions',
      gridPos: { x: 0, y: 1, w: 12, h: 8 },
      datasource,
      targets: [{ refId: 'A', datasource }]
    }
  ]
}

const ours = [
  {
    id: 1,
    type: 'row',
    title: 'KPI Metrics',
    gridPos: { x: 0, y: 0, w: 24, h: 1 }
  },
  {
    id: 2,
    type: 'stat',
    title: 'Journeys started',
    gridPos: { x: 0, y: 1, w: 12, h: 5 },
    datasource: { type: 'cloudwatch', uid: '${datasource}' },
    targets: [
      { refId: 'A', datasource: { type: 'cloudwatch', uid: '${datasource}' } }
    ]
  }
]

describe('#dashboard', () => {
  describe('maxPanelId', () => {
    it('should return the highest id in use', () => {
      expect(maxPanelId(target.panels)).toBe(9)
    })

    it('should look inside a collapsed row', () => {
      expect(
        maxPanelId([{ id: 2, type: 'row', panels: [{ id: 30, type: 'stat' }] }])
      ).toBe(30)
    })

    it('should return zero when nothing carries an id', () => {
      expect(maxPanelId([{ type: 'row' }])).toBe(0)
    })
  })

  describe('contentBottom', () => {
    it('should return the lowest edge of any panel', () => {
      expect(contentBottom(target.panels)).toBe(9)
    })
  })

  describe('cloudwatchDatasourceUid', () => {
    it('should read the uid the target already queries through', () => {
      expect(cloudwatchDatasourceUid(target)).toBe('target-uid')
    })

    it('should refuse a target with no cloudwatch datasource', () => {
      expect(() => cloudwatchDatasourceUid({ panels: [{ id: 1 }] })).toThrow(
        /cloudwatch/i
      )
    })
  })

  describe('mergeIntoTarget', () => {
    it('should drop the identifiers that belong to the source instance', () => {
      const merged = mergeIntoTarget(target, ours)

      expect(merged.id).toBeUndefined()
      expect(merged.uid).toBeUndefined()
    })

    it('should keep the target panels untouched and ahead of ours', () => {
      const merged = mergeIntoTarget(target, ours)

      expect(merged.panels.slice(0, 2)).toStrictEqual(target.panels)
    })

    it('should number our panels above the highest id in use', () => {
      const merged = mergeIntoTarget(target, ours)

      expect(merged.panels.slice(2).map(({ id }) => id)).toStrictEqual([10, 11])
    })

    it('should drop our panels below the existing content', () => {
      const merged = mergeIntoTarget(target, ours)

      expect(
        merged.panels.slice(2).map(({ gridPos }) => gridPos.y)
      ).toStrictEqual([9, 10])
    })

    it('should point our panels at the datasource the target uses', () => {
      const merged = mergeIntoTarget(target, ours)
      const [, stat] = merged.panels.slice(2)

      expect(stat.datasource.uid).toBe('target-uid')
      expect(stat.targets[0].datasource.uid).toBe('target-uid')
    })

    it('should not mutate the panels it was given', () => {
      mergeIntoTarget(target, ours)

      expect(ours[1].datasource?.uid).toBe('${datasource}')
    })
  })

  describe('targetStamp', () => {
    it('should record what the merge was built from', () => {
      const stamp = targetStamp('dev', {
        meta: { version: 3, updated: '2026-09-02T14:21:07Z' },
        dashboard: { uid: 'abc' }
      })

      expect(stamp).toStrictEqual({
        environment: 'dev',
        uid: 'abc',
        version: 3,
        updated: '2026-09-02T14:21:07Z'
      })
    })
  })

  describe('describeDrift', () => {
    const stamp = {
      environment: 'dev',
      uid: 'abc',
      version: 3,
      updated: '2026-09-02T14:21:07Z'
    }

    it('should report nothing when the target has not moved', () => {
      expect(describeDrift(stamp, stamp)).toBeNull()
    })

    it('should report a target promoted since the merge was built', () => {
      const drift = describeDrift(stamp, { ...stamp, version: 4 })

      expect(drift).toMatch(/version 3 .*4/)
    })

    it('should report an edit that did not move the version', () => {
      const drift = describeDrift(stamp, {
        ...stamp,
        updated: '2026-09-03T09:00:00Z'
      })

      expect(drift).toMatch(/2026-09-03T09:00:00Z/)
    })
  })
})
