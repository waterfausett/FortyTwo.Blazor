using Standart.Hash.xxHash;
using System;
using System.Text;
using System.Text.Json.Serialization;

namespace FortyTwo.Shared.Models
{
    public enum Orientation { Left, Right };

    public class Domino : IEquatable<Domino>
    {
        [JsonConstructor]
        public Domino(string id, int top, int bottom, Orientation orientation)
        {
            Id = id;
            Top = top;
            Bottom = bottom;
            Orientation = orientation;
        }

        public Domino(int top, int bottom, Orientation orientation = Orientation.Left)
        {
            if (top < 0) throw new ArgumentOutOfRangeException(nameof(top));
            if (bottom < 0) throw new ArgumentOutOfRangeException(nameof(bottom));

            if (top > bottom) throw new ArgumentOutOfRangeException("Invalid Domino creation.");

            Top = top;
            Bottom = bottom;

            var bytes = Encoding.UTF8.GetBytes($"{Top}/{Bottom}");
            Id = xxHash64.ComputeHash(bytes, bytes.Length).ToString();
        }

        public string Id { get; }
        public int Top { get; }
        public int Bottom { get; }
        public Orientation Orientation { get; set; }
        public int Value => ((Top + Bottom) % 5 == 0) ? (Top + Bottom) : 0;

        public bool IsDouble => this.Top == this.Bottom;

        public Suit GetSuit(Suit trump)
            => IsOfSuit(trump)
                ? trump
                : (Suit)(Math.Max(Top, Bottom));

        public bool IsOfSuit(Suit suit, Suit? trump = null)
            => trump == null || suit == trump
                ? (this.Top == (int)suit || this.Bottom == (int)suit)
                : (this.Top == (int)suit && this.Bottom != (int)trump ) || (this.Bottom == (int)suit && this.Top != (int)trump);

        public int GetSuitValue(Suit suit, Suit trump)
            => IsOfSuit(suit, trump)
                ? IsDouble ? 7 : this.Top == (int)suit ? this.Bottom : this.Top
                : IsOfSuit(trump)
                    ? 10 + (IsDouble ? 7 : this.Top == (int)suit ? this.Bottom : this.Top)
                    : -1;

        public bool Equals(Domino other)
        {
            return (this.Top == other.Top && this.Bottom == other.Bottom)
                || (this.Top == other.Bottom && this.Bottom == other.Top);
        }
    }
}
