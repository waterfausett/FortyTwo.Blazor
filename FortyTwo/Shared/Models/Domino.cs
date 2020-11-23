using System;

namespace FortyTwo.Shared.Models
{
    public class Domino : IEquatable<Domino>
    {
        public Domino()
        {

        }

        public Domino(int top, int bottom)
        {
            Top = top;
            Bottom = bottom;
        }

        public int Top { get; set; }
        public int Bottom { get; set; }
        public int Value => ((Top + Bottom) % 5 == 0) ? (Top + Bottom) : 0;

        public bool Equals(Domino other)
        {
            return (this.Top == other.Top && this.Bottom == other.Bottom)
                || (this.Top == other.Bottom && this.Bottom == other.Top);
        }
    }
}
