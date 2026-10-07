import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import styles from "./warehouse.module.css";

// Labelled form field. `full` spans both columns of a .formGrid.
export function Field({ id, label, hint, full = false, children }) {
  return (
    <div className={full ? `${styles.field} ${styles.fieldFull}` : styles.field}>
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint && <span className={styles.hint}>{hint}</span>}
    </div>
  );
}

export function TextField({ id, name = id, label, hint, full, ...props }) {
  return (
    <Field id={id} label={label} hint={hint} full={full}>
      <Input id={id} name={name} {...props} />
    </Field>
  );
}

// options: [{ value, label }]; `placeholder` adds an empty first option.
export function SelectField({ id, name = id, label, hint, full, options, placeholder, ...props }) {
  return (
    <Field id={id} label={label} hint={hint} full={full}>
      <select id={id} name={name} className={styles.select} {...props}>
        {placeholder !== undefined && <option value="">{placeholder}</option>}
        {options.map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled}>
            {option.label}
          </option>
        ))}
      </select>
    </Field>
  );
}

export function TextAreaField({ id, name = id, label, hint, full = true, ...props }) {
  return (
    <Field id={id} label={label} hint={hint} full={full}>
      <textarea id={id} name={name} className={styles.textarea} {...props} />
    </Field>
  );
}
