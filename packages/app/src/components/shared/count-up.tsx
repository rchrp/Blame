import { useCountUp } from "@/lib/use-count-up"

// A number that rolls to its new value instead of snapping.
export function CountUp({ value }: { value: number }) {
  return <>{useCountUp(value)}</>
}
