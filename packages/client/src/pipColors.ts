// Pip colours by count (0 has no pips), shared so a tile looks the same on web and mobile. Mobile
// paints them straight onto each pip; the web sets them as the --domino-N-color variables that
// domino.css and hall.css's .pip-face read.
export const PIP_COLORS: Record<number, string> = {
  1: '#5fa8d3',
  2: '#3f8f3a',
  3: '#cd5c5c',
  4: '#e0915a',
  5: '#2b3f8f',
  6: '#d4a514',
};
