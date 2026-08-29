import { clamp, findAnnotationKey, getFitState, parseAnnotations } from './annotations'

const xml = `
  <annotations>
    <meta><job><id>42</id><start_frame>1</start_frame><stop_frame>9</stop_frame></job></meta>
    <meta><task><labels><label><name>car</name><color>#ff0000</color></label></labels></task></meta>
    <image id="7" name="frames/car_007.jpg" width="100" height="50">
      <box label="car" xtl="1" ytl="2" xbr="30" ybr="40" />
    </image>
  </annotations>
`

describe('annotations', () => {
  it('parses metadata, labels, boxes, and lookup indexes', () => {
    const result = parseAnnotations(xml)
    expect(result.jobId).toBe('42')
    expect(result.labels).toEqual({ car: '#ff0000' })
    expect(result.images['frames/car_007.jpg'].boxes).toHaveLength(1)
    expect(result.lookupById.get('7')).toBe('frames/car_007.jpg')
  })

  it('matches annotations by filename and numeric suffix', () => {
    const result = parseAnnotations(xml)
    expect(
      findAnnotationKey(
        { name: 'frames/car_007.jpg' },
        result.images,
        result.lookupById,
        result.lookupByName,
      ),
    ).toBe('frames/car_007.jpg')
    expect(
      findAnnotationKey({ name: '7.png' }, result.images, result.lookupById, result.lookupByName),
    ).toBe('frames/car_007.jpg')
  })

  it('falls back when annotations were restored from JSON without Map indexes', () => {
    const result = parseAnnotations(xml)
    expect(findAnnotationKey({ name: 'car_007.jpg' }, result.images, {}, {})).toBe(
      'frames/car_007.jpg',
    )
  })

  it('clamps values and calculates a centered fit transform', () => {
    expect(clamp(15, 0, 10)).toBe(10)
    expect(
      getFitState(100, 50, { getBoundingClientRect: () => ({ width: 200, height: 200 }) }),
    ).toEqual({
      scale: 1.5,
      panX: 25,
      panY: 62.5,
    })
  })
})
