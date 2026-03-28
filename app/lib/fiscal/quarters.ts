/** Fiscal calendar arithmetic — presentation-layer only.
 *  All dates stored as absolute ISO in DB; mapping happens at query/render time.
 */

export interface FiscalCalendar {
  entityName: string;
  yearStartMonth: number; // 1=Jan
  quarterStartMonths: number[]; // e.g. [1, 4, 7, 10]
}

export interface FiscalQuarter {
  label: string; // e.g. "Q1 FY2026"
  fiscalYear: number;
  quarter: number; // 1-4
  startDate: Date;
  endDate: Date;
}

/** Map an absolute date to the entity's fiscal quarter. */
export function getFiscalQuarter(
  date: Date,
  calendar: Pick<FiscalCalendar, "yearStartMonth" | "quarterStartMonths">
): FiscalQuarter {
  const qStarts = calendar.quarterStartMonths; // 1-indexed months
  const month = date.getMonth() + 1; // 1-indexed
  const calYear = date.getFullYear();

  // Find which quarter this month falls in
  let quarter = 1;
  let qStartMonth = qStarts[0];
  for (let i = 0; i < qStarts.length; i++) {
    if (month >= qStarts[i]) {
      quarter = i + 1;
      qStartMonth = qStarts[i];
    }
  }

  // Fiscal year: if year starts in a month > Jan, dates before that month belong to prior FY
  const fiscalYear =
    month >= calendar.yearStartMonth ? calYear : calYear - 1;

  // Compute quarter start/end dates
  const startMonth = qStartMonth;
  const startYear =
    startMonth >= calendar.yearStartMonth ? fiscalYear : fiscalYear + 1;

  const nextQIndex = qStarts.indexOf(qStartMonth) + 1;
  const endMonth =
    nextQIndex < qStarts.length
      ? qStarts[nextQIndex] - 1
      : calendar.yearStartMonth + 10; // last quarter ends at FY end

  const startDate = new Date(startYear, startMonth - 1, 1);
  const endDate = new Date(
    nextQIndex < qStarts.length ? startYear : startYear + 1,
    nextQIndex < qStarts.length ? qStarts[nextQIndex] - 1 : calendar.yearStartMonth - 1,
    0 // last day of previous month
  );

  return {
    label: `Q${quarter} FY${fiscalYear}`,
    fiscalYear,
    quarter,
    startDate,
    endDate,
  };
}

/** List all fiscal quarters in a given fiscal year for a calendar. */
export function getFiscalQuartersForYear(
  fiscalYear: number,
  calendar: Pick<FiscalCalendar, "yearStartMonth" | "quarterStartMonths">
): FiscalQuarter[] {
  const qStarts = calendar.quarterStartMonths;
  return qStarts.map((startMonth, i) => {
    const calYear =
      startMonth >= calendar.yearStartMonth ? fiscalYear : fiscalYear + 1;
    const nextQIndex = i + 1;
    const endCalYear =
      nextQIndex < qStarts.length ? calYear : calYear + 1;
    const endMonth =
      nextQIndex < qStarts.length ? qStarts[nextQIndex] : calendar.yearStartMonth;

    return {
      label: `Q${i + 1} FY${fiscalYear}`,
      fiscalYear,
      quarter: i + 1,
      startDate: new Date(calYear, startMonth - 1, 1),
      endDate: new Date(endCalYear, endMonth - 1, 0),
    };
  });
}
