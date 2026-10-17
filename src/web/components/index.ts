// Shared presentational components for the Plugin (task 15.2).
// Importing this barrel also loads the global styles (focus-visible, visually-hidden).
import '../styles.css';

export { VALIDATION_NOTICE_TEXT, ValidationNotice, type ValidationNoticeProps } from './ValidationNotice';
export {
  DECISION_SUPPORT_LABEL,
  PathwayBadge,
  needsValidationNotice,
  pathwayLabel,
  type PathwayBadgeProps,
} from './PathwayBadge';
export { GatedValue, WithheldMarker, type GatedValueProps, type WithheldMarkerProps } from './WithheldMarker';
export { ErrorBanner, type ErrorBannerProps, type FieldError } from './ErrorBanner';
export {
  DEFAULT_LOADING_LABEL,
  LoadingIndicator,
  StatusMessage,
  type LoadingIndicatorProps,
  type StatusMessageProps,
} from './LoadingIndicator';
export { NO_SOH_HISTORY_TEXT, SohChart, type SohChartProps } from './SohChart';
