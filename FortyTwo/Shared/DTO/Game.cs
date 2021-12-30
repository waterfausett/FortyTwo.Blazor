using System;
using System.Collections.Generic;

namespace FortyTwo.Shared.Models.DTO
{
    public class Game
    {
        public Guid Id { get; set; }
        public string Name { get; set; }
        public string BiddingPlayerId { get; set; }
        public Bid? Bid { get; set; }
        public Suit? Trump { get; set; }
        public string CurrentPlayerId { get; set; }
        public Trick CurrentTrick { get; set; }
        public List<Trick> Tricks { get; set; } = new List<Trick>();
        public List<Hand> Hands { get; set; }
    }
}
