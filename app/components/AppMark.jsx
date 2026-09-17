export const APP_ICON_SRC = "/partialpay-icon.jpg";

export default function AppMark({ className = "page-mark", size = 42 }) {
  return (
    <img
      className={className}
      src={APP_ICON_SRC}
      alt=""
      width={size}
      height={size}
    />
  );
}
