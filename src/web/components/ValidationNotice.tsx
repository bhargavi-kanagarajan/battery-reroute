/** Exact Validation_Notice text (glossary; Req 6.13, 9.8, 10.5, 11.8). */
export const VALIDATION_NOTICE_TEXT = 'Certified specialist validation required' as const;

export interface ValidationNoticeProps {
  /** Optional id so a control can reference the notice via aria-describedby. */
  id?: string;
}

/** Inline notice placed adjacent to a pathway name or a referral/dispatch/accept/intake control. */
export function ValidationNotice({ id }: ValidationNoticeProps) {
  return (
    <span id={id} className="br-validation-notice" role="note" data-testid="validation-notice">
      {VALIDATION_NOTICE_TEXT}
    </span>
  );
}
