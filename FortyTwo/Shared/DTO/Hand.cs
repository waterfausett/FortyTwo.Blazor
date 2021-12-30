using System;

namespace FortyTwo.Shared.Models.DTO
{
    public class Hand
    {
        public string PlayerId { get; set; }
        public int TeamId { get; set; }
        public int Dominos { get; set; }
        public Bid? Bid { get; set; }
    }
}
