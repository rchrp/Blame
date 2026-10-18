// Missing aggregate counters never coerce to zero in comparisons/sensitivities.
export const finite=value=>typeof value==='number'&&Number.isFinite(value);
export const resourcesKnown=row=>row.contract.unreported===0&&row.usage.tokensCostReconciled&&['input','output','cost'].every(key=>finite(row.usage[key])&&row.usage[key]>=0);
export const sumUsage=(rows,key)=>rows.every(row=>finite(row.usage[key]))?rows.reduce((sum,row)=>sum+row.usage[key],0):null;
export const relativeDelta=(candidate,baseline)=>!finite(candidate)||!finite(baseline)||baseline===0?null:candidate/baseline-1;
