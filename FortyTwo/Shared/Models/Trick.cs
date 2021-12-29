using System;
using System.Linq;
using System.Text.Json.Serialization;

namespace FortyTwo.Shared.Models
{
    public class Trick
    {
        [JsonConstructor]
        public Trick() { }

        public string PlayerId { get; set; }
        public Guid? TeamId { get; set; }
        public Suit? Suit { get; set; }
        public Domino[] Dominos { get; set; } = new Domino[4];
        public int Value => Dominos?.Sum(x => x?.Value) + 1 ?? 0;
    }

    public static class TrickExtensions
    {
        public static bool IsFull(this Trick trick)
            => Array.IndexOf(trick.Dominos, null) == -1;

        public static void AddDomino(this Trick trick, Domino domino, Suit trump)
        {
            var index = Array.IndexOf(trick.Dominos, null);
            
            // TODO: think of a cleaner approach here
            if (index == -1) throw new Exception("Trick is already full");

            if (index == 0)
            {
                trick.Suit ??= domino.GetSuit(trump);
            }

            trick.Dominos[index] = domino;
        }
    }
}
