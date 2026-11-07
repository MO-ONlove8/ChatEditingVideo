import { type ButtonHTMLAttributes } from 'react';
import styles from './index.module.less';

export function Button({
  className = '',
  variant = 'secondary',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' }) {
  return (
    <button
      type="button"
      className={`${styles.button} ${variant === 'primary' ? styles.primary : ''} ${className}`}
      {...props}
    />
  );
}
