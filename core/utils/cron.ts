/**
 * Cron schedule parsing and next/previous date computation (parseCronExpression, Cron, longTimeout, etc.).
 *
 * @module
 */
/** Maximum value for setTimeout/setInterval in ms (2^31 - 1). Used by longTimeout to chunk longer delays. */
export const TIMEOUT_MAX = 2147483647;

/** Handle returned by longTimeout; holds the current timeout ID so the timeout can be cleared or chained. */
export interface ITimerHandle {
  /** Current setTimeout ID; updated when longTimeout chains past TIMEOUT_MAX. */
  timeoutId?: ReturnType<typeof setTimeout>;
}

/**
 * Creates a new timeout, which can exceed the max timeout limit of 2^31-1.
 * Since multiple timeouts are used internally, the timeoutId used to clear the timeout
 * is returned as a handle (object) and changes whenever the max timeout limit is exceeded.
 * The handle parameter can be ignored, it is used internally for updating the timeoutId
 * in the handle after creating the next timeout.
 */
export function longTimeout(
  fn: () => void,
  timeout: number,
  previousHandle?: ITimerHandle,
): ITimerHandle {
  let nextTimeout = timeout;
  let remainingTimeout = 0;

  if (nextTimeout > TIMEOUT_MAX) {
    remainingTimeout = nextTimeout - TIMEOUT_MAX;
    nextTimeout = TIMEOUT_MAX;
  }

  const handle = previousHandle ?? {
    timeoutId: undefined,
  };

  handle.timeoutId = setTimeout(() => {
    if (remainingTimeout > 0) {
      longTimeout(fn, remainingTimeout, previousHandle);
    } else {
      fn();
    }
  }, nextTimeout);

  return handle;
}

/**
 * Extract second, minute, hour, day, month, weekday, and year from a date. Month 0–11; weekday 0–6; day 1–31.
 * @param date - Source date
 * @returns Object with second, minute, hour, day, month, weekday, year
 */
export function extractDateElements(date: Date): {
  second: number;
  minute: number;
  hour: number;
  day: number;
  month: number;
  weekday: number;
  year: number;
} {
  return {
    second: date.getSeconds(),
    minute: date.getMinutes(),
    hour: date.getHours(),
    day: date.getDate(),
    month: date.getMonth(),
    weekday: date.getDay(),
    year: date.getFullYear(),
  };
}

/**
 * Number of days in the given month. Month is 0-indexed (0 = January).
 * @param year - Full year
 * @param month - Month 0–11
 * @returns Day count (28–31)
 */
export function getDaysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}

/**
 * Number of days from weekday1 to weekday2 (0–6, Sun–Sat). Handles wrap-around.
 * @param weekday1 - Start weekday 0–6
 * @param weekday2 - End weekday 0–6
 * @returns Day delta
 */
export function getDaysBetweenWeekdays(
  weekday1: number,
  weekday2: number,
): number {
  if (weekday1 <= weekday2) {
    return weekday2 - weekday1;
  }

  return 6 - weekday1 + weekday2 + 1;
}

/**
 * Wrap a function so sync throws and async rejections are passed to an optional error handler.
 * @param fn - Function to wrap (sync or async)
 * @param errorHandler - Optional callback for errors
 * @returns Wrapped function that catches errors
 */
export function wrapFunction(
  fn: () => unknown,
  errorHandler?: (err: unknown) => unknown,
) {
  return () => {
    try {
      const res = fn();

      if (res instanceof Promise) {
        res.catch((err) => {
          if (errorHandler) {
            errorHandler(err);
          }
        });
      }
    } catch (err) {
      if (errorHandler) {
        errorHandler(err);
      }
    }
  };
}

/**
 * An object with contains for each element of a date, which values are allowed.
 * Everything starting at 0, except for days.
 */
export interface ICronDefinition {
  readonly seconds: Set<number>;
  readonly minutes: Set<number>;
  readonly hours: Set<number>;
  readonly days: Set<number>;
  readonly months: Set<number>;
  readonly weekdays: Set<number>;
}

/**
 * Parsed cron schedule. Use getNextDate/getPrevDate or matchDate to compute or test dates. Built from parseCronExpression().
 */
export class Cron {
  /** Allowed seconds (0–59), sorted ascending. */
  public readonly seconds: ReadonlyArray<number>;
  public readonly minutes: ReadonlyArray<number>;
  public readonly hours: ReadonlyArray<number>;
  public readonly days: ReadonlyArray<number>;
  public readonly months: ReadonlyArray<number>;
  public readonly weekdays: ReadonlyArray<number>;

  public readonly reversed: {
    seconds: ReadonlyArray<number>;
    minutes: ReadonlyArray<number>;
    hours: ReadonlyArray<number>;
    days: ReadonlyArray<number>;
    months: ReadonlyArray<number>;
    weekdays: ReadonlyArray<number>;
  };

  /**
   * Build a Cron from allowed value sets. Use parseCronExpression() for string expressions.
   * @param definition - Sets of allowed seconds, minutes, hours, days, months, weekdays
   * @throws If any set is empty or values are out of range
   */
  public constructor({
    seconds,
    minutes,
    hours,
    days,
    months,
    weekdays,
  }: ICronDefinition) {
    // Validate that there are values provided.
    if (!seconds || seconds.size === 0) {
      throw new Error('There must be at least one allowed second.');
    }
    if (!minutes || minutes.size === 0) {
      throw new Error('There must be at least one allowed minute.');
    }
    if (!hours || hours.size === 0) {
      throw new Error('There must be at least one allowed hour.');
    }
    if (!months || months.size === 0) {
      throw new Error('There must be at least one allowed month.');
    }
    if ((!weekdays || weekdays.size === 0) && (!days || days.size === 0)) {
      throw new Error('There must be at least one allowed day or weekday.');
    }

    // Convert set to array and sort in ascending order.
    this.seconds = Array.from(seconds).sort((a, b) => a - b);
    this.minutes = Array.from(minutes).sort((a, b) => a - b);
    this.hours = Array.from(hours).sort((a, b) => a - b);
    this.days = Array.from(days).sort((a, b) => a - b);
    this.months = Array.from(months).sort((a, b) => a - b);
    this.weekdays = Array.from(weekdays).sort((a, b) => a - b);

    // Validate that all values are integers within the constraint.
    const validateData = (
      name: string,
      data: ReadonlyArray<number>,
      constraint: { min: number; max: number },
    ) => {
      if (
        data.some(
          (x) =>
            typeof x !== 'number' ||
            x % 1 !== 0 ||
            x < constraint.min ||
            x > constraint.max,
        )
      ) {
        throw new Error(
          `${name} must only consist of integers which are within the range of ${constraint.min} and ${constraint.max}`,
        );
      }
    };

    validateData('seconds', this.seconds, { min: 0, max: 59 });
    validateData('minutes', this.minutes, { min: 0, max: 59 });
    validateData('hours', this.hours, { min: 0, max: 23 });
    validateData('days', this.days, { min: 1, max: 31 });
    validateData('months', this.months, { min: 0, max: 11 });
    validateData('weekdays', this.weekdays, { min: 0, max: 6 });

    // For each element, store a reversed copy in the reversed attribute for finding prev dates.
    this.reversed = {
      seconds: this.seconds.map((x) => x).reverse(),
      minutes: this.minutes.map((x) => x).reverse(),
      hours: this.hours.map((x) => x).reverse(),
      days: this.days.map((x) => x).reverse(),
      months: this.months.map((x) => x).reverse(),
      weekdays: this.weekdays.map((x) => x).reverse(),
    };
  }

  /**
   * Find the next or previous hour, starting from the given start hour that matches the hour constraint.
   * startHour itself might also be allowed.
   */
  private findAllowedHour(
    dir: 'next' | 'prev',
    startHour: number,
  ): number | undefined {
    return dir === 'next'
      ? this.hours.find((x) => x >= startHour)
      : this.reversed.hours.find((x) => x <= startHour);
  }

  /**
   * Find the next or previous minute, starting from the given start minute that matches the minute constraint.
   * startMinute itself might also be allowed.
   */
  private findAllowedMinute(
    dir: 'next' | 'prev',
    startMinute: number,
  ): number | undefined {
    return dir === 'next'
      ? this.minutes.find((x) => x >= startMinute)
      : this.reversed.minutes.find((x) => x <= startMinute);
  }

  /**
   * Find the next or previous second, starting from the given start second that matches the second constraint.
   * startSecond itself IS NOT allowed.
   */
  private findAllowedSecond(
    dir: 'next' | 'prev',
    startSecond: number,
  ): number | undefined {
    return dir === 'next'
      ? this.seconds.find((x) => x > startSecond)
      : this.reversed.seconds.find((x) => x < startSecond);
  }

  /**
   * Find the next or previous time, starting from the given start time that matches the hour, minute
   * and second constraints. startTime itself might also be allowed.
   */
  private findAllowedTime(
    dir: 'next' | 'prev',
    startTime: { hour: number; minute: number; second: number },
  ): { hour: number; minute: number; second: number } | undefined {
    // Try to find an allowed hour.
    let hour = this.findAllowedHour(dir, startTime.hour);
    if (hour !== undefined) {
      if (hour === startTime.hour) {
        // We found an hour that is the start hour. Try to find an allowed minute.
        let minute = this.findAllowedMinute(dir, startTime.minute);
        if (minute !== undefined) {
          if (minute === startTime.minute) {
            // We found a minute that is the start minute. Try to find an allowed second.
            const second = this.findAllowedSecond(dir, startTime.second);
            if (second !== undefined) {
              // We found a second within the start hour and minute.
              return { hour, minute, second };
            }
            // We did not find a valid second within the start minute. Try to find another minute.
            minute = this.findAllowedMinute(
              dir,
              dir === 'next' ? startTime.minute + 1 : startTime.minute - 1,
            );
            if (minute !== undefined) {
              // We found a minute which is not the start minute. Return that minute together with the hour and the first / last allowed second.
              return {
                hour,
                minute,
                second: dir === 'next'
                  ? this.seconds[0]
                  : this.reversed.seconds[0],
              };
            }
          } else {
            // We found a minute which is not the start minute. Return that minute together with the hour and the first / last allowed second.
            return {
              hour,
              minute,
              second: dir === 'next'
                ? this.seconds[0]
                : this.reversed.seconds[0],
            };
          }
        }

        // We did not find an allowed minute / second combination inside the start hour. Try to find the next / previous allowed hour.
        hour = this.findAllowedHour(
          dir,
          dir === 'next' ? startTime.hour + 1 : startTime.hour - 1,
        );
        if (hour !== undefined) {
          // We found an allowed hour which is not the start hour. Return that hour together with the first / last allowed minutes / seconds.
          return {
            hour,
            minute: dir === 'next' ? this.minutes[0] : this.reversed.minutes[0],
            second: dir === 'next' ? this.seconds[0] : this.reversed.seconds[0],
          };
        }
      } else {
        // We found an allowed hour which is not the start hour. Return that hour together with the first / last allowed minutes / seconds.
        return {
          hour,
          minute: dir === 'next' ? this.minutes[0] : this.reversed.minutes[0],
          second: dir === 'next' ? this.seconds[0] : this.reversed.seconds[0],
        };
      }
    }

    // No allowed time found.
    return undefined;
  }

  /**
   * Find the next or previous day in the given month, starting from the given startDay
   * that matches either the day or the weekday constraint. startDay itself might also be allowed.
   */
  private findAllowedDayInMonth(
    dir: 'next' | 'prev',
    year: number,
    month: number,
    startDay: number,
  ): number | undefined {
    if (startDay < 1) throw new Error('startDay must not be smaller than 1.');
    // If only days are restricted: allow day based on day constraint only.
    // If only weekdays are restricted: allow day based on weekday constraint only.
    // If both are restricted: allow day based on both day and weekday constraint. pick day that is closer to startDay.
    // If none are restricted: return the day closest to startDay (respecting dir) that is allowed (or startDay itself).

    const daysInMonth = getDaysInMonth(year, month);
    const daysRestricted = this.days.length !== 31;
    const weekdaysRestricted = this.weekdays.length !== 7;

    if (!daysRestricted && !weekdaysRestricted) {
      if (startDay > daysInMonth) {
        return dir === 'next' ? undefined : daysInMonth;
      }

      return startDay;
    }

    // Try to find a day based on the days constraint.
    let allowedDayByDays: number | undefined;
    if (daysRestricted) {
      allowedDayByDays = dir === 'next'
        ? this.days.find((x) => x >= startDay)
        : this.reversed.days.find((x) => x <= startDay);

      // Make sure the day does not exceed the amount of days in month.
      if (allowedDayByDays !== undefined && allowedDayByDays > daysInMonth) {
        allowedDayByDays = undefined;
      }
    }

    // Try to find a day based on the weekday constraint.
    let allowedDayByWeekdays: number | undefined;
    if (weekdaysRestricted) {
      const startWeekday = new Date(year, month, startDay).getDay();
      const nearestAllowedWeekday = dir === 'next'
        ? (this.weekdays.find((x) => x >= startWeekday) ?? this.weekdays[0])
        : (this.reversed.weekdays.find((x) => x <= startWeekday) ??
          this.reversed.weekdays[0]);

      if (nearestAllowedWeekday !== undefined) {
        const daysBetweenWeekdays = dir === 'next'
          ? getDaysBetweenWeekdays(startWeekday, nearestAllowedWeekday)
          : getDaysBetweenWeekdays(nearestAllowedWeekday, startWeekday);

        allowedDayByWeekdays = dir === 'next'
          ? startDay + daysBetweenWeekdays
          : startDay - daysBetweenWeekdays;

        // Make sure the day does not exceed the month boundaries.
        if (allowedDayByWeekdays > daysInMonth || allowedDayByWeekdays < 1) {
          allowedDayByWeekdays = undefined;
        }
      }
    }

    if (allowedDayByDays !== undefined && allowedDayByWeekdays !== undefined) {
      // If a day is found both via the days and the weekdays constraint, pick the day
      // that is closer to start date.
      return dir === 'next'
        ? Math.min(allowedDayByDays, allowedDayByWeekdays)
        : Math.max(allowedDayByDays, allowedDayByWeekdays);
    }

    if (allowedDayByDays !== undefined) {
      return allowedDayByDays;
    }

    if (allowedDayByWeekdays !== undefined) {
      return allowedDayByWeekdays;
    }

    return undefined;
  }

  /** Gets the next date starting from the given start date or now. */
  public getNextDate(startDate: Date = new Date()): Date {
    const startDateElements = extractDateElements(startDate);
    let minYear = startDateElements.year;

    let startIndexMonth = this.months.findIndex(
      (x) => x >= startDateElements.month,
    );
    if (startIndexMonth === -1) {
      startIndexMonth = 0;
      minYear++;
    }

    // We try every month within the next 5 years to make sure that we tried to
    // find a matching date insidde a whole leap year.
    const maxIterations = this.months.length * 5;

    for (let i = 0; i < maxIterations; i++) {
      // Get the next year and month.
      const year = minYear +
        Math.floor((startIndexMonth + i) / this.months.length);
      const month = this.months[(startIndexMonth + i) % this.months.length];
      const isStartMonth = year === startDateElements.year &&
        month === startDateElements.month;

      // Find the next day.
      let day = this.findAllowedDayInMonth(
        'next',
        year,
        month,
        isStartMonth ? startDateElements.day : 1,
      );
      let isStartDay = isStartMonth && day === startDateElements.day;

      // If we found a day and it is the start day, try to find a valid time beginning from the start date time.
      if (day !== undefined && isStartDay) {
        const nextTime = this.findAllowedTime('next', startDateElements);
        if (nextTime !== undefined) {
          return new Date(
            year,
            month,
            day,
            nextTime.hour,
            nextTime.minute,
            nextTime.second,
          );
        }

        // If no valid time has been found for the start date, try the next day.
        day = this.findAllowedDayInMonth('next', year, month, day + 1);
        isStartDay = false;
      }

      // If we found a next day and it is not the start day, just use the next day with the first allowed values
      // for hours, minutes and seconds.
      if (day !== undefined && !isStartDay) {
        return new Date(
          year,
          month,
          day,
          this.hours[0],
          this.minutes[0],
          this.seconds[0],
        );
      }

      // No allowed day has been found for this month. Continue to search in next month.
    }

    throw new Error('No valid next date was found.');
  }

  /** Gets the specified amount of future dates starting from the given start date or now. */
  public getNextDates(amount: number, startDate?: Date): Date[] {
    const dates = [];
    let nextDate: Date | undefined;

    for (let i = 0; i < amount; i++) {
      nextDate = this.getNextDate(nextDate ?? startDate);
      dates.push(nextDate);
    }

    return dates;
  }

  /**
   * Get an ES6 compatible iterator which iterates over the next dates starting from startDate or now.
   * The iterator runs until the optional endDate is reached or forever.
   */
  public *getNextDatesIterator(
    startDate?: Date,
    endDate?: Date,
  ): Generator<Date, undefined, undefined> {
    let nextDate: Date | undefined;

    while (true) {
      nextDate = this.getNextDate(nextDate ?? startDate);

      if (endDate && endDate.getTime() < nextDate.getTime()) {
        return;
      }

      yield nextDate;
    }
  }

  /** Gets the previous date starting from the given start date or now. */
  public getPrevDate(startDate: Date = new Date()): Date {
    const startDateElements = extractDateElements(startDate);
    let maxYear = startDateElements.year;

    let startIndexMonth = this.reversed.months.findIndex(
      (x) => x <= startDateElements.month,
    );
    if (startIndexMonth === -1) {
      startIndexMonth = 0;
      maxYear--;
    }

    // We try every month within the past 5 years to make sure that we tried to
    // find a matching date inside a whole leap year.
    const maxIterations = this.reversed.months.length * 5;

    for (let i = 0; i < maxIterations; i++) {
      // Get the next year and month.
      const year = maxYear -
        Math.floor((startIndexMonth + i) / this.reversed.months.length);
      const month = this.reversed.months[
        (startIndexMonth + i) % this.reversed.months.length
      ];
      const isStartMonth = year === startDateElements.year &&
        month === startDateElements.month;

      // Find the previous day.
      let day = this.findAllowedDayInMonth(
        'prev',
        year,
        month,
        isStartMonth
          ? startDateElements.day
          // Start searching from the last day of the month.
          : getDaysInMonth(year, month),
      );
      let isStartDay = isStartMonth && day === startDateElements.day;

      // If we found a day and it is the start day, try to find a valid time beginning from the start date time.
      if (day !== undefined && isStartDay) {
        const prevTime = this.findAllowedTime('prev', startDateElements);
        if (prevTime !== undefined) {
          return new Date(
            year,
            month,
            day,
            prevTime.hour,
            prevTime.minute,
            prevTime.second,
          );
        }

        // If no valid time has been found for the start date, try the previous day.
        if (day > 1) {
          day = this.findAllowedDayInMonth('prev', year, month, day - 1);
          isStartDay = false;
        }
      }

      // If we found a previous day and it is not the start day, just use the previous day with the first allowed values
      // for hours, minutes and seconds (which will be the latest time due to using the reversed array).
      if (day !== undefined && !isStartDay) {
        return new Date(
          year,
          month,
          day,
          this.reversed.hours[0],
          this.reversed.minutes[0],
          this.reversed.seconds[0],
        );
      }

      // No allowed day has been found for this month. Continue to search in previous month.
    }

    throw new Error('No valid previous date was found.');
  }

  /** Gets the specified amount of previous dates starting from the given start date or now. */
  public getPrevDates(amount: number, startDate?: Date): Date[] {
    const dates = [];
    let prevDate: Date | undefined;

    for (let i = 0; i < amount; i++) {
      prevDate = this.getPrevDate(prevDate ?? startDate);
      dates.push(prevDate);
    }

    return dates;
  }

  /**
   * Get an ES6 compatible iterator which iterates over the previous dates starting from startDate or now.
   * The iterator runs until the optional endDate is reached or forever.
   */
  public *getPrevDatesIterator(
    startDate?: Date,
    endDate?: Date,
  ): Generator<Date, undefined, undefined> {
    let prevDate: Date | undefined;

    while (true) {
      prevDate = this.getPrevDate(prevDate ?? startDate);

      if (endDate && endDate.getTime() > prevDate.getTime()) {
        return;
      }

      yield prevDate;
    }
  }

  /** Returns true when there is a cron date at the given date. */
  public matchDate(date: Date): boolean {
    const { second, minute, hour, day, month, weekday } = extractDateElements(
      date,
    );

    if (
      this.seconds.indexOf(second) === -1 ||
      this.minutes.indexOf(minute) === -1 ||
      this.hours.indexOf(hour) === -1 ||
      this.months.indexOf(month) === -1
    ) {
      return false;
    }

    if (this.days.length !== 31 && this.weekdays.length !== 7) {
      return (
        this.days.indexOf(day) !== -1 || this.weekdays.indexOf(weekday) !== -1
      );
    }

    return (
      this.days.indexOf(day) !== -1 && this.weekdays.indexOf(weekday) !== -1
    );
  }
}

interface IConstraint {
  min: number;
  max: number;
  aliases?: Record<string, string>;
}

const secondConstraint: IConstraint = {
  min: 0,
  max: 59,
};

const minuteConstraint: IConstraint = {
  min: 0,
  max: 59,
};

const hourConstraint: IConstraint = {
  min: 0,
  max: 23,
};

const dayConstraint: IConstraint = {
  min: 1,
  max: 31,
};

const monthConstraint: IConstraint = {
  min: 1,
  max: 12,
  aliases: {
    jan: '1',
    feb: '2',
    mar: '3',
    apr: '4',
    may: '5',
    jun: '6',
    jul: '7',
    aug: '8',
    sep: '9',
    oct: '10',
    nov: '11',
    dec: '12',
  },
};

const weekdayConstraint: IConstraint = {
  min: 0,
  max: 7,
  aliases: {
    mon: '1',
    tue: '2',
    wed: '3',
    thu: '4',
    fri: '5',
    sat: '6',
    sun: '7',
  },
};

const timeNicknames: Record<string, string | undefined> = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@hourly': '0 * * * *',
  '@minutely': '* * * * *',
};

function parseElement(element: string, constraint: IConstraint): Set<number> {
  const result = new Set<number>();

  // If returned set of numbers is empty, the scheduler class interpretes the emtpy set of numbers as all valid values of the constraint
  if (element === '*') {
    for (let i = constraint.min; i <= constraint.max; i = i + 1) {
      result.add(i);
    }

    return result;
  }

  // If the element is a list, parse each element in the list.
  const listElements = element.split(',');
  if (listElements.length > 1) {
    for (const listElement of listElements) {
      const parsedListElement = parseElement(listElement, constraint);
      for (const x of parsedListElement) {
        result.add(x);
      }
    }

    return result;
  }

  // Helper function to parse a single element, which includes checking for alias, valid number and constraint min and max.
  const parseSingleElement = (singleElement: string): number => {
    singleElement = constraint.aliases?.[singleElement.toLowerCase()] ??
      singleElement;
    const parsedElement = Number.parseInt(singleElement, 10);

    if (Number.isNaN(parsedElement)) {
      throw new Error(`Failed to parse ${element}: ${singleElement} is NaN.`);
    }

    if (parsedElement < constraint.min || parsedElement > constraint.max) {
      throw new Error(
        `Failed to parse ${element}: ${singleElement} is outside of constraint range of ${constraint.min} - ${constraint.max}.`,
      );
    }

    return parsedElement;
  };

  // Detect if the element is a range.
  // Possible range formats: 'start-end', 'start-end/step', '*', '*/step'.
  // Where start and end can be numbers or aliases.
  // Capture groups: 1: start-end, 2: start, 3: end, 4: /step, 5: step.
  const rangeSegments = /^(([0-9a-zA-Z]+)-([0-9a-zA-Z]+)|\*)(\/([0-9]+))?$/
    .exec(element);

  // If not, it must be a single element.
  if (rangeSegments === null) {
    result.add(parseSingleElement(element));
    return result;
  }

  // If it is a range, get start and end of the range.
  let parsedStart = rangeSegments[1] === '*'
    ? constraint.min
    : parseSingleElement(rangeSegments[2]);

  const parsedEnd = rangeSegments[1] === '*'
    ? constraint.max
    : parseSingleElement(rangeSegments[3]);

  // need to catch Sunday, which gets parsed here as 7, but is also legitimate at the start of a range as 0, to avoid the out of order error
  if (
    constraint === weekdayConstraint &&
    parsedStart === 7 &&
    // this check ensures that sun-sun is not incorrectly parsed as [0,1,2,3,4,5,6]
    parsedEnd !== 7
  ) {
    parsedStart = 0;
  }

  if (parsedStart > parsedEnd) {
    throw new Error(
      `Failed to parse ${element}: Invalid range (start: ${parsedStart}, end: ${parsedEnd}).`,
    );
  }

  // Check whether there is a custom step defined for the range, defaulting to 1.
  const step = rangeSegments[5] as string | undefined;
  let parsedStep = 1;

  if (step !== undefined) {
    parsedStep = Number.parseInt(step, 10);
    if (Number.isNaN(parsedStep)) {
      throw new Error(`Failed to parse step: ${step} is NaN.`);
    }
    if (parsedStep < 1) {
      throw new Error(
        `Failed to parse step: Expected ${step} to be greater than 0.`,
      );
    }
  }

  // Go from start to end of the range by the given steps.
  for (let i = parsedStart; i <= parsedEnd; i = i + parsedStep) {
    result.add(i);
  }

  return result;
}

/**
 * Parse a cron expression (5 or 6 fields) into a Cron. Supports ranges, steps, and nicknames (e.g. @daily).
 * @param cronExpression - Cron string (e.g. '0 * * * *' for hourly)
 * @returns Cron instance for getNextDate/getPrevDate/matchDate
 * @throws If the expression is invalid
 */
export function parseCronExpression(cronExpression: string): Cron {
  if (typeof cronExpression !== 'string') {
    throw new TypeError('Invalid cron expression: must be of type string.');
  }

  // Convert time nicknames.
  cronExpression = timeNicknames[cronExpression.toLowerCase()] ??
    cronExpression;

  // Split the cron expression into its elements, removing empty elements (extra whitespaces).
  const elements = cronExpression.split(' ').filter((elem) => elem.length > 0);
  if (elements.length < 5 || elements.length > 6) {
    throw new Error('Invalid cron expression: expected 5 or 6 elements.');
  }

  const rawSeconds = elements.length === 6 ? elements[0] : '0';
  const rawMinutes = elements.length === 6 ? elements[1] : elements[0];
  const rawHours = elements.length === 6 ? elements[2] : elements[1];
  const rawDays = elements.length === 6 ? elements[3] : elements[2];
  const rawMonths = elements.length === 6 ? elements[4] : elements[3];
  const rawWeekdays = elements.length === 6 ? elements[5] : elements[4];

  return new Cron({
    seconds: parseElement(rawSeconds, secondConstraint),
    minutes: parseElement(rawMinutes, minuteConstraint),
    hours: parseElement(rawHours, hourConstraint),
    days: parseElement(rawDays, dayConstraint),
    // months in cron are indexed by 1, but Cron expects indexes by 0, so we need to reduce all set values by one.
    months: new Set(
      Array.from(parseElement(rawMonths, monthConstraint)).map((x) => x - 1),
    ),
    weekdays: new Set(
      Array.from(parseElement(rawWeekdays, weekdayConstraint)).map(
        (x) => x % 7,
      ),
    ),
  });
}

// cron
// jsr:@p4sca1/cron-schedule@^6.0.0 - copied directly from the package as i was having some issue on deployment
