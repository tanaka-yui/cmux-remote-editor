import { type RefObject, useCallback, useEffect, useRef } from 'react'
import { useSwipeable } from 'react-swipeable'
import { usePinchZoom } from 'react-use'

// react-use's ZoomState enum is not re-exported from the package root; compare
// against its string values directly.
const ZOOMING_IN = 'ZOOMING_IN'
const ZOOMING_OUT = 'ZOOMING_OUT'

interface UseGestureOptions {
  onSwipeUp?: () => void
  onSwipeDown?: () => void
  onSwipeLeft: () => void
  onSwipeRight: () => void
  onPinchIn?: () => void
  onPinchOut?: () => void
}

const SWIPE_THRESHOLD = 50

function haptic() {
  if (navigator.vibrate) navigator.vibrate(10)
}

export function useGesture(options: UseGestureOptions) {
  const optionsRef = useRef(options)
  optionsRef.current = options

  const pinchRef = useRef<HTMLElement | null>(null)
  const { zoomingState } = usePinchZoom(pinchRef as RefObject<HTMLElement>)

  const swipe = useSwipeable({
    onSwipedUp: () => {
      if (!optionsRef.current.onSwipeUp) return
      optionsRef.current.onSwipeUp()
      haptic()
    },
    onSwipedDown: () => {
      if (!optionsRef.current.onSwipeDown) return
      optionsRef.current.onSwipeDown()
      haptic()
    },
    onSwipedLeft: () => {
      optionsRef.current.onSwipeLeft()
      haptic()
    },
    onSwipedRight: () => {
      optionsRef.current.onSwipeRight()
      haptic()
    },
    delta: SWIPE_THRESHOLD,
    trackTouch: true,
    trackMouse: false,
  })

  useEffect(() => {
    const state = zoomingState as string | null
    if (state === ZOOMING_IN) optionsRef.current.onPinchIn?.()
    else if (state === ZOOMING_OUT) optionsRef.current.onPinchOut?.()
  }, [zoomingState])

  // Wire both react-swipeable's ref and react-use's pinch ref to the same element.
  return useCallback(
    (el: HTMLElement | null) => {
      pinchRef.current = el
      swipe.ref(el)
    },
    [swipe],
  )
}
